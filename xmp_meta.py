"""XMP rating and keyword read/write for the comfyui-gallery-loader pack.

SHARED MODULE — canonical home: ``comfyui-gallery-loader/xmp_meta.py``.
Other packs (comfyui-image-browser) vendor this file **verbatim** via
their ``just sync-xmp`` recipe, with CI drift-checking the copy. Land
fixes in comfyui-gallery-loader, then re-sync the vendored copies.
Keep it pure stdlib with no ComfyUI imports so it stays portable.

Pure, stdlib-only helpers (``struct``/``zlib``/``xml.etree``/``os``/
``tempfile``) — no ComfyUI imports, so this module unit-tests in a bare
environment. The pack stays MIT and takes **no new dependencies**.

Ratings are stored as the cross-tool-standard ``xmp:Rating`` (integer
0..5; 0 = unrated) mirrored to ``MicrosoftPhoto:Rating`` (0/1/25/50/75/99
percent) so Windows Explorer shows them too.

Keywords are stored as ``dc:subject`` — the Dublin Core "Keywords" array
every photo manager already reads and writes (digiKam, Lightroom, Bridge,
XnView, ExifTool, Windows Explorer) — mirrored to
``MicrosoftPhoto:LastKeywordXMP``, exactly as the rating is mirrored.
There is no canonical XMP "sensitive" property (IPTC 2025.1 defines
none), so a keyword *is* the interoperable representation: a file this
pack marks sensitive reads as tagged in digiKam, and a file digiKam
tagged reads as sensitive here.

Persistence, by priority:

1. **In-file, lossless** for PNG and JPEG via raw chunk/segment surgery —
   pixels (and ComfyUI's ``prompt``/``workflow``/``parameters`` text
   chunks) are copied verbatim; only the XMP packet is inserted/replaced.
2. **Sidecar** ``<path>.xmp`` for every other format (webp, avif, gif,
   tiff, video) and whenever an in-file write can't be done losslessly.

Reading checks in-file XMP first (so ratings set by Lightroom / Windows
are honoured), then the sidecar.

Writing is **read-modify-write**: an existing packet is parsed, only the
properties this write actually owns are touched, and every other property
(``dc:description`` captions, ``dc:creator``, ``dc:rights``, …) is
re-serialised untouched under its original prefix. A packet we cannot
parse safely is never overwritten — see :func:`update_xmp_packet`.

Two kinds of owned property, and the difference is load-bearing
---------------------------------------------------------------

``xmp:Rating`` is **scalar**: one value, legal as an attribute on
``rdf:Description`` or as a child element, and a write replaces it
wholesale. ``dc:subject`` is an **array** — an ``rdf:Bag`` of ``rdf:li``
elements — and cannot be an attribute at all:

.. code-block:: xml

    <dc:subject><rdf:Bag><rdf:li>portrait</rdf:li></rdf:Bag></dc:subject>

That difference forces three design choices, each of which prevents a
data-loss bug of the same family as #97:

1. **``OWNED_PROPERTIES`` is split, and a write strips only its own
   half.** A rating write strips ``OWNED_SCALAR_PROPERTIES``; a keyword
   write strips nothing (see 2) and touches ``OWNED_BAG_PROPERTIES``
   only. Stripping the union on every write would make a star click
   delete the file's keywords — the #97 bug wearing a different hat.
2. **A keyword write is a DELTA, not a replacement.** ``update_xmp_packet``
   takes ``add_tags`` / ``remove_tags`` and edits the existing
   ``rdf:li`` elements in place, because the existing packet is the only
   place the file's other keywords live. Rebuilding the bag from a list
   the caller computed would drop whatever the caller had not read —
   and the caller cannot read it reliably, since which packet it will
   write to (in-file or sidecar) is decided *inside* the write.
   Editing ``rdf:li`` elements rather than re-emitting them is also what
   keeps an ``xml:lang`` qualifier on a keyword alive.
3. **Read whichever container is there.** ``dc:subject`` is specified as
   ``rdf:Bag``, but writers in the wild emit ``rdf:Seq``, ``rdf:Alt``,
   and even the bare simple-value form ``<dc:subject>x</dc:subject>``.
   Reading assumes none of them; writing preserves the container it
   found and only creates an ``rdf:Bag`` when there was nothing at all.
"""

from __future__ import annotations

import contextlib
import logging
import os
import tempfile
import zlib
from collections.abc import Callable, Iterator, Sequence
from xml.etree import ElementTree as ET

log = logging.getLogger("comfyui-xmp")

# --- XMP namespaces ---------------------------------------------------
NS_XMP = "http://ns.adobe.com/xap/1.0/"
NS_MS = "http://ns.microsoft.com/photo/1.0/"
NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
NS_DC = "http://purl.org/dc/elements/1.1/"
# Bound to the `xml` prefix by the XML spec itself; never declared inline.
NS_XML = "http://www.w3.org/XML/1998/namespace"

# The properties this module owns. Everything else in a packet belongs to
# whoever wrote it (digiKam, Lightroom, Bridge, XnView) and is preserved.
#
# The split is not cosmetic — see the module docstring. A SCALAR property is
# replaced wholesale and is stripped in both legal serialisations before the
# new value is set. A BAG property holds the file's other keywords, so it is
# never stripped; it is edited element-by-element by _apply_tag_delta. A write
# only ever touches the half it is for: a rating write must not disturb
# keywords, and a keyword write must not disturb the rating.
OWNED_SCALAR_PROPERTIES = (f"{{{NS_XMP}}}Rating", f"{{{NS_MS}}}Rating")
OWNED_BAG_PROPERTIES = (f"{{{NS_DC}}}subject", f"{{{NS_MS}}}LastKeywordXMP")
OWNED_PROPERTIES = OWNED_SCALAR_PROPERTIES + OWNED_BAG_PROPERTIES

RDF_LI = f"{{{NS_RDF}}}li"
# dc:subject is specified as rdf:Bag, but rdf:Seq and rdf:Alt both turn up in
# the wild. Read any of them; keep whichever one the file already had.
RDF_CONTAINERS = (f"{{{NS_RDF}}}Bag", f"{{{NS_RDF}}}Seq", f"{{{NS_RDF}}}Alt")

# A keyword longer than this is not a keyword. Bounds what a single write can
# add to a packet that other tools have to re-read.
MAX_TAG_LEN = 128

# --- format markers ---------------------------------------------------
PNG_SIG = b"\x89PNG\r\n\x1a\n"
PNG_XMP_KEYWORD = b"XML:com.adobe.xmp"
JPEG_XMP_PREFIX = b"http://ns.adobe.com/xap/1.0/\x00"  # 29 bytes

# --- limits -----------------------------------------------------------
MAX_XMP_BYTES = 256 * 1024  # reject larger packets before parsing (DoS guard)
JPEG_APP1_MAX = 0xFFFF  # APP1 length field is 16-bit
PNG_HEAD_SCAN = 512 * 1024  # bounded head read for the cheap /list probe

_RATING_TO_PERCENT = {0: 0, 1: 1, 2: 25, 3: 50, 4: 75, 5: 99}
_PERCENT_BUCKETS = [(0, 0), (1, 1), (25, 2), (50, 3), (75, 4), (99, 5)]


# ---------------------------------------------------------------------------
# Rating <-> Microsoft percent
# ---------------------------------------------------------------------------


def clamp_rating(rating: object) -> int:
    """Coerce an arbitrary value to an int rating in 0..5 (0 on failure)."""
    try:
        r = int(rating)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
    return max(0, min(5, r))


def rating_to_ms_percent(rating: int) -> int:
    return _RATING_TO_PERCENT[clamp_rating(rating)]


def ms_percent_to_rating(percent: int) -> int:
    """Map a 0..100 MicrosoftPhoto percent to the nearest 0..5 bucket."""
    p = max(0, min(100, int(percent)))
    return min(_PERCENT_BUCKETS, key=lambda b: abs(b[0] - p))[1]


# ---------------------------------------------------------------------------
# XMP packet build / parse
# ---------------------------------------------------------------------------


XPACKET_BEGIN = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
XPACKET_END = '<?xpacket end="w"?>'
XPACKET_PAD = 2048


def _wrap_packet(body: str, pad: int = XPACKET_PAD) -> bytes:
    """Wrap a serialised ``x:xmpmeta`` body in the ``<?xpacket?>`` envelope.

    ``pad`` bytes of trailing whitespace follow the XMP per convention (lets
    other editors expand the packet in place).
    """
    return (XPACKET_BEGIN + body + (" " * pad) + "\n" + XPACKET_END).encode("utf-8")


def build_xmp_packet(rating: int | None = 0, tags: Sequence[str] = ()) -> bytes:
    """Return a complete ``<?xpacket?>``-wrapped XMP packet (UTF-8 bytes).

    Used only when a file has **no** existing packet. When one exists, go
    through :func:`update_xmp_packet` instead — this function's output
    contains nothing but the properties asked for here, so writing it over an
    existing packet destroys every other property the file carried.

    ``rating=None`` omits the rating pair entirely (a keyword-only write must
    not invent a rating of 0 for a file nobody rated). With no tags the output
    is byte-identical to what shipped before this function grew a second
    parameter — fresh ComfyUI renders must not change shape.

    Ratings are validated ints; keywords are XML-escaped on the way in, so
    neither is an injection surface.
    """
    attrs = ""
    ns = ""
    if rating is not None:
        r = clamp_rating(rating)
        ns += '\n    xmlns:xmp="http://ns.adobe.com/xap/1.0/"'
        ns += '\n    xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"'
        attrs += f'\n    xmp:Rating="{r}"'
        attrs += f'\n    MicrosoftPhoto:Rating="{rating_to_ms_percent(r)}"'
    kept = _dedupe_tags(tags)
    if kept:
        if rating is None:
            ns += '\n    xmlns:MicrosoftPhoto="http://ns.microsoft.com/photo/1.0/"'
        ns += '\n    xmlns:dc="http://purl.org/dc/elements/1.1/"'
    if not kept:
        desc = f'  <rdf:Description rdf:about=""{ns}{attrs}/>\n'
    else:
        bags = "".join(
            f"   <{prop}>\n    <rdf:Bag>\n"
            + "".join(f"     <rdf:li>{_esc_text(t)}</rdf:li>\n" for t in kept)
            + "    </rdf:Bag>\n"
            f"   </{prop}>\n"
            for prop in ("dc:subject", "MicrosoftPhoto:LastKeywordXMP")
        )
        desc = f'  <rdf:Description rdf:about=""{ns}{attrs}>\n{bags}  </rdf:Description>\n'
    body = (
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
        ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n'
        f"{desc}"
        " </rdf:RDF>\n"
        "</x:xmpmeta>\n"
    )
    return _wrap_packet(body)


def _packet_is_parseable(xmp_bytes: bytes | None) -> bool:
    """Gate an untrusted packet before handing it to the XML parser.

    Reject packets over ``MAX_XMP_BYTES`` and any DOCTYPE/ENTITY declaration
    (XXE / billion-laughs). Both the reader and the read-modify-write path go
    through this, so a packet we refuse to *read* is also one we refuse to
    *rewrite* — we never overwrite bytes we would not parse.
    """
    if not xmp_bytes or len(xmp_bytes) > MAX_XMP_BYTES:
        return False
    lowered = xmp_bytes.lower()
    return b"<!doctype" not in lowered and b"<!entity" not in lowered


def parse_rating_from_xmp(xmp_bytes: bytes | None) -> int | None:
    """Extract a 0..5 rating from an XMP packet, or None.

    Security: see :func:`_packet_is_parseable`. A caller that wants the
    keywords too should use :func:`parse_meta_from_xmp`, which parses once.
    """
    if not _packet_is_parseable(xmp_bytes):
        return None
    try:
        root = ET.fromstring(xmp_bytes)
    except ET.ParseError:
        return None
    return _find_rating(root)


def _find_rating(root: ET.Element) -> int | None:
    xmp_val: str | None = None
    ms_val: str | None = None
    xmp_attr = f"{{{NS_XMP}}}Rating"
    ms_attr = f"{{{NS_MS}}}Rating"
    for el in root.iter():
        if xmp_val is None:
            xmp_val = el.attrib.get(xmp_attr)
        if ms_val is None:
            ms_val = el.attrib.get(ms_attr)
        if xmp_val is None and el.tag == xmp_attr and el.text:
            xmp_val = el.text.strip()
        if ms_val is None and el.tag == ms_attr and el.text:
            ms_val = el.text.strip()
    if xmp_val is not None:
        try:
            return max(0, min(5, int(float(xmp_val))))
        except ValueError:
            pass
    if ms_val is not None:
        try:
            return ms_percent_to_rating(int(float(ms_val)))
        except ValueError:
            pass
    return None


# ---------------------------------------------------------------------------
# dc:subject keywords
# ---------------------------------------------------------------------------


def normalize_tag(tag: object) -> str:
    """Canonical form of one keyword: trimmed, inner whitespace collapsed.

    Returns ``""`` for anything that is not usable as a keyword (empty, all
    whitespace, longer than :data:`MAX_TAG_LEN`, or carrying a control
    character — the latter would serialise into the packet and come back
    mangled or, in a C0 range XML forbids, unparseable).
    """
    if not isinstance(tag, str):
        return ""
    collapsed = " ".join(tag.split())
    if not collapsed or len(collapsed) > MAX_TAG_LEN:
        return ""
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in collapsed):
        return ""
    return collapsed


def _tag_key(tag: object) -> str:
    """Comparison key. Keywords are matched case-insensitively so a file does
    not end up carrying both ``NSFW`` and ``nsfw``; the *stored* casing is
    always whichever the file (or the caller) already used."""
    return normalize_tag(tag).casefold()


def _dedupe_tags(tags: Sequence[str]) -> list[str]:
    """Normalized, deduped (case-insensitively), order preserved."""
    out: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        value = normalize_tag(tag)
        key = value.casefold()
        if not value or key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _property_values(root: ET.Element, name: str) -> list[str] | None:
    """Every value of array-valued property ``name``, or None if it is absent.

    ``None`` and ``[]`` are different answers: the first means "this file says
    nothing about keywords" (so a sidecar may), the second means "this file
    says it has none". Accepts all three shapes seen in the wild — an
    ``rdf:Bag``/``Seq``/``Alt`` of ``rdf:li``, the bare simple-value form
    ``<dc:subject>x</dc:subject>``, and the attribute form ``dc:subject="x"``.
    """
    found = False
    values: list[str] = []
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        attr = el.attrib.get(name)
        if attr is not None:
            found = True
            values.append(attr)
        if el.tag != name:
            continue
        found = True
        container = next((c for c in el if c.tag in RDF_CONTAINERS), None)
        if container is None:
            values.append(el.text or "")
            continue
        values.extend(li.text or "" for li in container if li.tag == RDF_LI)
    return _dedupe_tags(values) if found else None


def _find_tags(root: ET.Element) -> list[str] | None:
    """``dc:subject`` if the packet has it, else the ``MicrosoftPhoto`` mirror.

    The mirror exists so Windows shows what we wrote, not as a second source
    of truth — so it is only ever a fallback for a file tagged somewhere that
    writes nothing else.
    """
    for name in OWNED_BAG_PROPERTIES:
        values = _property_values(root, name)
        if values is not None:
            return values
    return None


def parse_meta_from_xmp(xmp_bytes: bytes | None) -> tuple[int | None, list[str] | None]:
    """``(rating, keywords)`` from one packet, parsing it ONCE.

    A directory listing reads both for every file, and going through
    :func:`parse_rating_from_xmp` and :func:`parse_tags_from_xmp` in turn
    parses the same bytes twice — measured at +40% on the metadata pass over a
    2000-file directory, for nothing. Both single-property functions delegate
    here. Security: see :func:`_packet_is_parseable`.
    """
    if not _packet_is_parseable(xmp_bytes):
        return None, None
    try:
        root = ET.fromstring(xmp_bytes)
    except ET.ParseError:
        return None, None
    return _find_rating(root), _find_tags(root)


def parse_tags_from_xmp(xmp_bytes: bytes | None) -> list[str] | None:
    """Keywords from an XMP packet, or None when the packet carries none."""
    return parse_meta_from_xmp(xmp_bytes)[1]


# ---------------------------------------------------------------------------
# Read-modify-write: set our two properties, preserve everybody else's
# ---------------------------------------------------------------------------
#
# Why parse-and-re-serialise rather than splice the packet bytes: an XMP
# property is legal both as an attribute on ``rdf:Description`` and as a child
# element (digiKam writes ``dc:subject`` as an ``rdf:Bag`` child), and either
# form may carry our ``xmp:Rating``. Locating and excising both forms in raw
# bytes means tokenising XML, which is the fragile-regex trap; a parser already
# does it correctly. This is also what Adobe's own XMP SDK does on update.
#
# The cost of re-serialising is that ``ElementTree`` resolves prefixes away at
# parse time and re-invents them as ``ns0:``/``ns1:`` on output — semantically
# equivalent, but it rewrites every foreign property's prefix and reads as
# corruption to a human. Registering prefixes with ``ET.register_namespace``
# would fix that by mutating a process-global map shared with every other
# ElementTree user in the ComfyUI process (a packet declaring
# ``xmlns:rdf="http://evil/"`` would poison it), so instead we collect the
# document's own prefix→URI declarations and serialise with a small writer of
# our own that honours them.
#
# Not preserved: comments and processing instructions inside the packet, and
# the exact placement of namespace declarations (all are hoisted to the root).
# Neither carries an XMP property; Adobe's SDK drops them too.


def _alloc_prefix(want: str, used: set[str]) -> str:
    """Return an unused prefix, preferring ``want``.

    A default (empty) prefix is deliberately never handed out: it cannot bind
    an *attribute* name, and XMP has no use for one.
    """
    base = want or "ns"
    if base not in used:
        used.add(base)
        return base
    i = 2
    while f"{base}{i}" in used:
        i += 1
    used.add(f"{base}{i}")
    return f"{base}{i}"


def _collect_prefixes(xmp_bytes: bytes) -> dict[str, str]:
    """Return the packet's own ``uri -> prefix`` map, in declaration order."""
    prefixes: dict[str, str] = {NS_XML: "xml"}
    used = {"xml", "xmlns"}
    pull = ET.XMLPullParser(events=("start-ns",))
    with contextlib.suppress(ET.ParseError):
        pull.feed(xmp_bytes)
        pull.close()
    for _event, (prefix, uri) in pull.read_events():
        if uri not in prefixes:
            prefixes[uri] = _alloc_prefix(prefix, used)
    return prefixes


def _ensure_prefixes(root: ET.Element, prefixes: dict[str, str]) -> None:
    """Give every namespace used anywhere in the tree a prefix, before output.

    Done as a pre-pass so the root's ``xmlns:`` declarations are complete: a
    prefix invented halfway through serialisation would never be declared.
    """
    used = set(prefixes.values())
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue  # comment / processing instruction
        for name in (el.tag, *el.attrib):
            if name.startswith("{"):
                uri = name[1:].partition("}")[0]
                if uri not in prefixes:
                    prefixes[uri] = _alloc_prefix("ns", used)


def _qname(name: str, prefixes: dict[str, str]) -> str:
    if not name.startswith("{"):
        return name
    uri, _, local = name[1:].partition("}")
    return f"{prefixes[uri]}:{local}"


def _esc_text(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(value: str) -> str:
    # Literal tabs/newlines in an attribute survive serialisation but are
    # normalised to spaces by the *next* parser to read the file, so a caption
    # written with line breaks would silently flatten. Escape them numerically.
    return (
        _esc_text(value)
        .replace('"', "&quot;")
        .replace("\t", "&#9;")
        .replace("\n", "&#10;")
        .replace("\r", "&#13;")
    )


def _write_element(
    el: ET.Element, prefixes: dict[str, str], out: list[str], *, root: bool
) -> None:
    if el.tag is ET.Comment:
        out.append(f"<!--{el.text or ''}-->")
    elif el.tag is ET.ProcessingInstruction:
        out.append(f"<?{el.text or ''}?>")
    else:
        qname = _qname(el.tag, prefixes)
        out.append(f"<{qname}")
        if root:
            for uri, prefix in prefixes.items():
                if uri != NS_XML:  # bound by the spec; declaring it is noise
                    out.append(f' xmlns:{prefix}="{_esc_attr(uri)}"')
        for key, value in el.attrib.items():
            out.append(f' {_qname(key, prefixes)}="{_esc_attr(value)}"')
        if len(el) == 0 and el.text is None:
            out.append("/>")
            out.append(_esc_text(el.tail or ""))
            return
        out.append(">")
        out.append(_esc_text(el.text or ""))
        for child in el:
            _write_element(child, prefixes, out, root=False)
        out.append(f"</{qname}>")
    out.append(_esc_text(el.tail or ""))


def _drop_child(parent: ET.Element, child: ET.Element, previous: ET.Element | None) -> None:
    """Remove ``child``, handing its tail to whatever preceded it so the
    indentation of the following sibling is unchanged."""
    if previous is not None:
        previous.tail = child.tail
    else:
        parent.text = child.tail
    parent.remove(child)


def _strip_owned_properties(parent: ET.Element, names: Sequence[str]) -> None:
    """Remove the named properties wherever they appear, in either legal form.

    ``names`` is always a *subset* of what this module owns — the scalar half
    for a rating write. Passing the union would delete the file's keywords on
    every star click; see the module docstring.
    """
    for name in names:
        parent.attrib.pop(name, None)
    previous: ET.Element | None = None
    for child in list(parent):
        if isinstance(child.tag, str) and child.tag in names:
            _drop_child(parent, child, previous)
            continue
        _strip_owned_properties(child, names)
        previous = child


def _tag_container(holder: ET.Element) -> ET.Element:
    """The ``rdf:Bag``/``Seq``/``Alt`` inside a keyword property, creating an
    ``rdf:Bag`` when there is none.

    A holder carrying a bare simple value (``<dc:subject>x</dc:subject>``) has
    that value promoted into the new bag rather than dropped — it is one of
    the file's keywords, written in a shape the spec does not use for arrays
    but that real files do.
    """
    container = next((c for c in holder if c.tag in RDF_CONTAINERS), None)
    if container is not None:
        return container
    seed = normalize_tag(holder.text or "")
    holder.text = None
    container = ET.SubElement(holder, RDF_CONTAINERS[0])
    if seed:
        ET.SubElement(container, RDF_LI).text = seed
    return container


def _apply_tag_delta(
    root: ET.Element,
    desc: ET.Element,
    name: str,
    add: Sequence[str],
    remove: Sequence[str],
) -> None:
    """Add/remove keywords on property ``name``, editing ``rdf:li`` in place.

    In place, and not "rebuild the bag from a list", for two reasons. The
    caller's list can only ever hold what the caller managed to read, and the
    file's other keywords are exactly what must survive; and an ``rdf:li`` may
    carry an ``xml:lang`` qualifier, which re-emitting the value as a plain
    string silently discards.
    """
    remove_keys = {_tag_key(t) for t in remove} - {""}
    holder = next(
        (el for el in root.iter() if isinstance(el.tag, str) and el.tag == name), None
    )
    # The attribute form of an array property is not legal RDF for an array,
    # but writers emit it. Fold it into the bag (unless it is being removed)
    # rather than leaving a second, contradictory copy behind.
    seeds: list[str] = []
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue
        attr = el.attrib.pop(name, None)
        if attr is not None and _tag_key(attr) not in remove_keys:
            seeds.append(attr)
    wanted = _dedupe_tags([*seeds, *add])
    if holder is None:
        if not wanted:
            return  # nothing to add and nothing there — leave the packet alone
        holder = ET.SubElement(desc, name)
        # Take the trailing indentation of the element it now follows, and
        # hand that element the indentation that separates two siblings.
        if len(desc) > 1:
            previous_holder = desc[-2]
            holder.tail = previous_holder.tail
            previous_holder.tail = desc.text
        else:
            holder.tail = desc.text
    container = _tag_container(holder)

    present: set[str] = set()
    previous: ET.Element | None = None
    for child in list(container):
        if child.tag != RDF_LI:
            previous = child
            continue
        key = _tag_key(child.text or "")
        if not key or key in remove_keys or key in present:
            _drop_child(container, child, previous)
            continue
        present.add(key)
        previous = child
    for value in wanted:
        key = value.casefold()
        if key in present or key in remove_keys:
            continue
        li = ET.SubElement(container, RDF_LI)
        li.text = value
        # Inherit the indentation of the element it now follows, and give that
        # element the indentation that used to separate two siblings.
        if previous is not None:
            li.tail = previous.tail
            previous.tail = container.text
        else:
            li.tail = container.text
        present.add(key)
        previous = li


def _primary_description(root: ET.Element) -> ET.Element | None:
    """Return the ``rdf:Description`` our properties belong on, creating one
    if the packet has an ``rdf:RDF`` but no description. None if the document
    is not an RDF-shaped XMP packet at all."""
    rdf = root if root.tag == f"{{{NS_RDF}}}RDF" else root.find(f"{{{NS_RDF}}}RDF")
    if rdf is None:
        return None
    desc = rdf.find(f"{{{NS_RDF}}}Description")
    if desc is not None:
        return desc
    desc = ET.SubElement(rdf, f"{{{NS_RDF}}}Description", {f"{{{NS_RDF}}}about": ""})
    desc.tail = rdf.text
    return desc


def update_xmp_packet(
    existing: bytes | None,
    rating: int | None = None,
    *,
    add_tags: Sequence[str] = (),
    remove_tags: Sequence[str] = (),
    pad: int = XPACKET_PAD,
) -> bytes | None:
    """Return ``existing`` with only the properties named here changed.

    Every other property — ``dc:description`` captions, ``dc:creator``,
    ``dc:rights``, anything a photo manager wrote — is carried through
    untouched, along with the prefix each was declared under. With no existing
    packet, this is exactly :func:`build_xmp_packet`.

    ``rating=None`` leaves the rating alone; empty ``add_tags``/``remove_tags``
    leave the keywords alone. **A rating write must not disturb keywords and a
    keyword write must not disturb the rating** — that is why each half is
    opt-in rather than one "here is the new state" argument.

    Keywords are a DELTA because the existing packet is the only place the
    file's other keywords live, and the caller cannot pre-read them: which
    packet gets written (in-file or sidecar) is decided inside the write.

    Returns **None** to mean *refuse*: the packet is oversize, carries a
    DOCTYPE/ENTITY, does not parse, or is not RDF-shaped. The caller must not
    overwrite it — the safe move is the sidecar, which the same three gates
    make :func:`read_meta` prefer anyway (an unreadable in-file packet does
    not mask a sidecar rating or keyword).
    """
    r = clamp_rating(rating) if rating is not None else None
    tagging = bool(add_tags) or bool(remove_tags)
    if not existing:
        return build_xmp_packet(r, _dedupe_tags(add_tags))
    if not _packet_is_parseable(existing):
        return None
    try:
        parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True, insert_pis=True))
        root = ET.fromstring(existing, parser)
    except ET.ParseError:
        return None
    desc = _primary_description(root)
    if desc is None:
        return None

    if r is not None:
        _strip_owned_properties(root, OWNED_SCALAR_PROPERTIES)
        desc.set(f"{{{NS_XMP}}}Rating", str(r))
        desc.set(f"{{{NS_MS}}}Rating", str(rating_to_ms_percent(r)))
    if tagging:
        # Both properties take the SAME delta rather than the mirror being
        # rebuilt from dc:subject: rebuilding would drop a keyword some other
        # tool had written only to the mirror, which is the preservation law
        # this module exists for, applied one property along.
        for name in OWNED_BAG_PROPERTIES:
            _apply_tag_delta(root, desc, name, add_tags, remove_tags)

    prefixes = _collect_prefixes(existing)
    if r is not None:
        prefixes.setdefault(NS_XMP, _alloc_prefix("xmp", set(prefixes.values())))
    if r is not None or tagging:
        prefixes.setdefault(NS_MS, _alloc_prefix("MicrosoftPhoto", set(prefixes.values())))
    if tagging:
        prefixes.setdefault(NS_DC, _alloc_prefix("dc", set(prefixes.values())))
    _ensure_prefixes(root, prefixes)

    out: list[str] = []
    _write_element(root, prefixes, out, root=True)
    body = "".join(out)
    if not body.endswith("\n"):
        body += "\n"
    return _wrap_packet(body, pad)


# ---------------------------------------------------------------------------
# PNG iTXt surgery (lossless)
# ---------------------------------------------------------------------------


def _iter_png_chunks(data: bytes) -> Iterator[tuple[str, bytes, int, int]]:
    """Yield (type, chunk_data, start, end) for each PNG chunk.

    ``start:end`` is the full chunk slice (length + type + data + CRC).
    Raises ValueError on a bad signature or truncated chunk.
    """
    if data[:8] != PNG_SIG:
        raise ValueError("not a PNG")
    i, n = 8, len(data)
    while i + 8 <= n:
        length = int.from_bytes(data[i : i + 4], "big")
        ctype = data[i + 4 : i + 8].decode("latin-1")
        data_start = i + 8
        data_end = data_start + length
        chunk_end = data_end + 4
        if chunk_end > n:
            raise ValueError("truncated PNG chunk")
        yield ctype, data[data_start:data_end], i, chunk_end
        i = chunk_end
        if ctype == "IEND":
            break


def _make_itxt(keyword: bytes, text: bytes) -> bytes:
    # keyword \0 compflag(0) compmethod(0) lang \0 translated \0 text
    cdata = keyword + b"\x00\x00\x00\x00\x00" + text
    body = b"iTXt" + cdata
    crc = zlib.crc32(body) & 0xFFFFFFFF
    return len(cdata).to_bytes(4, "big") + body + crc.to_bytes(4, "big")


def _is_xmp_text_chunk(ctype: str, cdata: bytes) -> bool:
    return ctype in ("iTXt", "tEXt", "zTXt") and cdata.startswith(PNG_XMP_KEYWORD + b"\x00")


def _png_text_chunk_xmp(ctype: str, cdata: bytes) -> bytes | None:
    if not _is_xmp_text_chunk(ctype, cdata):
        return None
    rest = cdata[len(PNG_XMP_KEYWORD) + 1 :]
    if ctype == "tEXt":
        return rest
    if ctype == "zTXt":
        try:
            return zlib.decompress(rest[1:])  # skip compression-method byte
        except (zlib.error, IndexError):
            return None
    # iTXt: keyword \0 compflag compmethod lang \0 translated \0 text
    if len(rest) < 2:
        return None
    compflag = rest[0]
    p = len(PNG_XMP_KEYWORD) + 1 + 2  # past keyword \0, compflag, compmethod
    for _ in range(2):  # skip language tag, then translated keyword
        nl = cdata.find(b"\x00", p)
        if nl < 0:
            return None
        p = nl + 1
    text = cdata[p:]
    if compflag == 1:
        try:
            return zlib.decompress(text)
        except zlib.error:
            return None
    return text


def png_get_xmp(data: bytes, *, stop_at_idat: bool = True) -> bytes | None:
    """Return the XMP packet from a PNG's text chunk, or None.

    ``stop_at_idat`` (the default) stops before the pixel data, which is what
    the cheap ``/list`` probe wants — it only ever reads ``PNG_HEAD_SCAN``
    bytes, so chunks past IDAT are not in the buffer anyway. The **write**
    path must pass False: ``png_set_xmp`` drops an XMP chunk wherever it sits,
    so a trailing one has to be read before it is replaced or its properties
    are lost.
    """
    try:
        for ctype, cdata, _s, _e in _iter_png_chunks(data):
            if stop_at_idat and ctype == "IDAT":
                break
            pkt = _png_text_chunk_xmp(ctype, cdata)
            if pkt is not None:
                return pkt
    except ValueError:
        pass
    return None


def png_set_xmp(data: bytes, xmp_packet: bytes) -> bytes:
    """Return new PNG bytes with the XMP iTXt inserted before the first
    IDAT, replacing any existing XMP text chunk. All other chunks (incl.
    ComfyUI metadata and pixels) are copied verbatim."""
    out = bytearray(PNG_SIG)
    new_chunk = _make_itxt(PNG_XMP_KEYWORD, xmp_packet)
    inserted = False
    for ctype, cdata, start, end in _iter_png_chunks(data):
        if _is_xmp_text_chunk(ctype, cdata):
            continue
        if not inserted and ctype in ("IDAT", "IEND"):
            out += new_chunk
            inserted = True
        out += data[start:end]
    if not inserted:
        out += new_chunk
    return bytes(out)


# ---------------------------------------------------------------------------
# JPEG APP1 surgery (lossless)
# ---------------------------------------------------------------------------


def _split_jpeg(data: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    """Return (segments, tail). ``segments`` is a list of (marker, bytes)
    up to the start of scan; ``tail`` is SOS..EOI raw."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    i, n = 2, len(data)
    segments: list[tuple[int, bytes]] = []
    while i + 1 < n:
        if data[i] != 0xFF:
            raise ValueError("bad JPEG marker")
        marker = data[i + 1]
        if marker == 0xD9:  # EOI
            break
        if marker == 0x01 or 0xD0 <= marker <= 0xD7:  # standalone markers
            segments.append((marker, data[i : i + 2]))
            i += 2
            continue
        if marker == 0xDA:  # SOS — scan data follows
            return segments, data[i:]
        seg_len = int.from_bytes(data[i + 2 : i + 4], "big")
        seg_end = i + 2 + seg_len
        if seg_end > n:
            raise ValueError("truncated JPEG segment")
        segments.append((marker, data[i:seg_end]))
        i = seg_end
    return segments, data[i:]


def jpeg_get_xmp(data: bytes) -> bytes | None:
    try:
        segments, _tail = _split_jpeg(data)
    except ValueError:
        return None
    for marker, seg in segments:
        if marker == 0xE1 and seg[4:].startswith(JPEG_XMP_PREFIX):
            return seg[4 + len(JPEG_XMP_PREFIX) :]
    return None


def jpeg_set_xmp(data: bytes, xmp_packet: bytes) -> bytes | None:
    """Return new JPEG bytes with the XMP APP1 inserted after SOI (after a
    leading APP0 if present), replacing any existing XMP APP1. Returns None
    if the segment would exceed the 16-bit length field — caller falls back
    to a sidecar."""
    payload = JPEG_XMP_PREFIX + xmp_packet
    seg_len = 2 + len(payload)
    if seg_len > JPEG_APP1_MAX:
        return None
    new_app1 = b"\xff\xe1" + seg_len.to_bytes(2, "big") + payload

    segments, tail = _split_jpeg(data)
    kept = [(m, s) for (m, s) in segments if not (m == 0xE1 and s[4:].startswith(JPEG_XMP_PREFIX))]
    insert_pos = 1 if kept and kept[0][0] == 0xE0 else 0

    out = bytearray(b"\xff\xd8")
    for idx, (_m, s) in enumerate(kept):
        if idx == insert_pos:
            out += new_app1
        out += s
    if insert_pos >= len(kept):
        out += new_app1
    out += tail
    return bytes(out)


# ---------------------------------------------------------------------------
# Sidecar
# ---------------------------------------------------------------------------


# One packet update, deferred: takes the packet found in whichever backend is
# about to be written (None when there is none) plus the padding that backend
# can afford, and returns the replacement — or None to refuse it. Deferred
# because "which packet" is not known until the write path has picked a
# backend, and a keyword delta has to be merged against THAT packet.
_PacketUpdate = Callable[[bytes | None, int], "bytes | None"]


def sidecar_path(path: str) -> str:
    return path + ".xmp"


def sidecar_get_rating(path: str) -> int | None:
    sp = sidecar_path(path)
    try:
        if not os.path.isfile(sp) or os.path.getsize(sp) > MAX_XMP_BYTES:
            return None
        with open(sp, "rb") as f:
            data = f.read()
    except OSError:
        return None
    return parse_rating_from_xmp(data)


def sidecar_read_packet(path: str) -> bytes | None:
    """Return the sidecar's raw packet bytes, or None if there is no sidecar.

    Reads one byte past ``MAX_XMP_BYTES`` so an oversize sidecar comes back
    oversize rather than truncated — :func:`update_xmp_packet` then refuses
    it instead of rewriting a packet it only half read.
    """
    sp = sidecar_path(path)
    try:
        if not os.path.isfile(sp):
            return None
        with open(sp, "rb") as f:
            return f.read(MAX_XMP_BYTES + 1)
    except OSError:
        return None


def sidecar_set_rating(path: str, rating: int) -> bool:
    """Set the rating in ``<path>.xmp``, preserving the sidecar's other
    properties. Returns False without writing when an existing sidecar cannot
    be safely updated — overwriting it would destroy keywords and captions
    that exist nowhere else."""
    packet = update_xmp_packet(sidecar_read_packet(path), clamp_rating(rating))
    if packet is None:
        return False
    _atomic_write(sidecar_path(path), packet)
    return True


def sidecar_apply(path: str, apply: _PacketUpdate) -> bool:
    """Run one packet update against ``<path>.xmp``. Same refusal contract as
    :func:`sidecar_set_rating` — False means nothing was written."""
    packet = apply(sidecar_read_packet(path), XPACKET_PAD)
    if packet is None:
        return False
    _atomic_write(sidecar_path(path), packet)
    return True


# ---------------------------------------------------------------------------
# Atomic write
# ---------------------------------------------------------------------------


def _atomic_write(path: str, data: bytes) -> None:
    directory = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".glxmp_", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise


# ---------------------------------------------------------------------------
# Top-level read / write dispatch (+ small cache for /list)
# ---------------------------------------------------------------------------


def _read_head(path: str, limit: int | None) -> bytes:
    with open(path, "rb") as f:
        return f.read(limit) if limit else f.read()


def _in_file_packet(path: str, ext: str, limit: int | None) -> bytes | None:
    if ext == ".png":
        return png_get_xmp(_read_head(path, limit))
    if ext in (".jpg", ".jpeg"):
        return jpeg_get_xmp(_read_head(path, limit))
    return None


def read_meta(path: str, *, head_only: bool = True) -> tuple[int, list[str]]:
    """Return ``(rating, keywords)``. In-file XMP first, then sidecar. Never
    raises — degrades to ``(0, [])`` on any error.

    ONE pass for both, because the caller (a directory listing) pays for the
    file open. The two are resolved independently: a file can carry an in-file
    rating and sidecar keywords, and taking the whole answer from whichever
    packet happened to hold the rating would silently drop the other.
    """
    try:
        ext = os.path.splitext(path)[1].lower()
        pkt = _in_file_packet(path, ext, PNG_HEAD_SCAN if head_only else None)
        rating, tags = parse_meta_from_xmp(pkt)
        if rating is None or tags is None:
            sc_rating, sc_tags = parse_meta_from_xmp(sidecar_read_packet(path))
            if rating is None:
                rating = sc_rating
            if tags is None:
                tags = sc_tags
        return (rating or 0), (tags or [])
    except Exception as exc:
        # Best-effort read: any failure degrades to "unrated, untagged", but
        # log so a corrupt file or XMP packet is diagnosable.
        log.debug("read_meta failed for %s: %s", path, exc)
        return 0, []


def read_rating(path: str, *, head_only: bool = True) -> int:
    """Return 0..5 (0 = unrated). Never raises — returns 0 on any error."""
    return read_meta(path, head_only=head_only)[0]


def read_tags(path: str, *, head_only: bool = True) -> list[str]:
    """Return the file's ``dc:subject`` keywords (possibly empty). Never
    raises."""
    return read_meta(path, head_only=head_only)[1]


def _write_xmp(path: str, apply: _PacketUpdate) -> tuple[bool, str]:
    """Run one packet update against ``path``. Returns (ok, backend) where
    backend is 'png' | 'jpeg' | 'sidecar', or (False, error).

    Read-modify-write throughout: ``apply`` is handed the packet that is
    already in the backend being written, so an existing packet's other
    properties are preserved (see :func:`update_xmp_packet`). When that packet
    cannot be parsed safely the in-file write is **refused** rather than
    overwritten, and the write goes to the sidecar — which :func:`read_meta`
    will read, because the same gate that refused the rewrite also stops the
    in-file packet from being read.

    Both the rating and the keyword write go through here, so neither can
    quietly grow a path that rebuilds the packet instead of updating it.
    """
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".png":
            with open(path, "rb") as f:
                data = f.read()
            packet = apply(png_get_xmp(data, stop_at_idat=False), XPACKET_PAD)
            if packet is not None:
                _atomic_write(path, png_set_xmp(data, packet))
                _cache_invalidate(path)
                return True, "png"
        elif ext in (".jpg", ".jpeg"):
            with open(path, "rb") as f:
                data = f.read()
            existing = jpeg_get_xmp(data)
            packet = apply(existing, XPACKET_PAD)
            out_opt = jpeg_set_xmp(data, packet) if packet is not None else None
            if out_opt is None and packet is not None:
                # The APP1 length field is 16-bit and we just grew the packet
                # by preserving it. Retry without the expansion padding.
                packet = apply(existing, 0)
                out_opt = jpeg_set_xmp(data, packet) if packet is not None else None
            if out_opt is not None:
                _atomic_write(path, out_opt)
                _cache_invalidate(path)
                return True, "jpeg"
            if existing is not None and packet is not None:
                # A readable in-file packet too large to rewrite: a sidecar
                # would be shadowed by the stale in-file packet, so say so
                # rather than report a write the reader will never see.
                return False, "existing XMP packet is too large to update in place"
        # Other formats, an unparseable packet we refuse to clobber, and JPEG
        # overflow with nothing readable in the file → sidecar.
        if not sidecar_apply(path, apply):
            return False, "existing XMP sidecar could not be updated safely"
        _cache_invalidate(path)
        return True, "sidecar"
    except (OSError, ValueError) as exc:
        log.warning("in-file XMP write failed for %s; wrote sidecar instead: %s", path, exc)
        try:
            if not sidecar_apply(path, apply):
                return False, "existing XMP sidecar could not be updated safely"
            _cache_invalidate(path)
            return True, "sidecar"
        except OSError:
            log.warning("sidecar XMP write also failed for %s", path, exc_info=True)
            return False, str(exc)


def write_rating(path: str, rating: int) -> tuple[bool, str]:
    """Write ``rating`` (clamped 0..5). Returns (ok, backend) — see
    :func:`_write_xmp`.

    Keywords are untouched: this passes no tag delta, so ``dc:subject`` is
    neither stripped nor rebuilt.
    """
    r = clamp_rating(rating)
    return _write_xmp(path, lambda existing, pad: update_xmp_packet(existing, r, pad=pad))


def write_tags(
    path: str, *, add: Sequence[str] = (), remove: Sequence[str] = ()
) -> tuple[bool, str]:
    """Add and/or remove ``dc:subject`` keywords. Returns (ok, backend) — see
    :func:`_write_xmp`.

    A DELTA, not a replacement: the keywords already on the file survive, and
    the merge happens against the packet in whichever backend is written. The
    rating is untouched (no rating argument reaches
    :func:`update_xmp_packet`), which is the other half of the same law.
    """
    adds = _dedupe_tags(add)
    removes = _dedupe_tags(remove)
    if not adds and not removes:
        return False, "no keywords to write"
    return _write_xmp(
        path,
        lambda existing, pad: update_xmp_packet(
            existing, add_tags=adds, remove_tags=removes, pad=pad
        ),
    )


# A tiny cache keyed on (path, mtime_ns, size) so re-listing a directory
# (the common "refresh after rating") doesn't re-read every file. Rating and
# keywords share one entry because they come from one read — caching them
# separately would double the file opens the cache exists to avoid.
_META_CACHE: dict[tuple[str, int, int], tuple[int, list[str]]] = {}
_CACHE_MAX = 5000


def read_meta_cached(path: str, st: os.stat_result) -> tuple[int, list[str]]:
    key = (path, st.st_mtime_ns, st.st_size)
    val = _META_CACHE.get(key)
    if val is not None:
        return val
    val = read_meta(path, head_only=True)
    if len(_META_CACHE) >= _CACHE_MAX:
        _META_CACHE.clear()
    _META_CACHE[key] = val
    return val


def read_rating_cached(path: str, st: os.stat_result) -> int:
    return read_meta_cached(path, st)[0]


def _cache_invalidate(path: str) -> None:
    for key in [k for k in _META_CACHE if k[0] == path]:
        _META_CACHE.pop(key, None)
