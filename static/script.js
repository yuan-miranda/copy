const $ = id => document.getElementById(id);
const area = $("paste");
const gutters = $("gutters");
const statusEl = $("status");
const userCountEl = $("user-count");
const fileInput = $("file-input");

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg|heic|heif)$/i;
const IMAGE_URL_PREFIX = "/pastebin-image/";

let socket = null;
let saveTimer = null;
let statusTimer = null;
let reconnectTimer = null;
let pageCaching = false;
let selectedImg = null;
let resizeState = null;
let lastRange = null;

// ---------- Identity ----------

// A cookie identifies this browser to the server, so its cursor color stays the
// same across reconnects. The server reads it during the websocket handshake.
(function ensureUserCookie() {
    if (/(?:^|; )pastebin_uid=/.test(document.cookie)) return;
    const bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    const id = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    document.cookie = `pastebin_uid=${id}; max-age=31536000; path=/; SameSite=Lax`;
})();

// ---------- Helpers ----------

function setStatus(text, duration = 0) {
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    if (duration > 0) {
        statusTimer = setTimeout(() => { statusEl.textContent = ""; }, duration);
    }
}

// Fires the normal input pipeline: gutter refresh + debounced sync to the server.
function notifyChange() {
    area.dispatchEvent(new Event("input"));
}

function getLineHeight() {
    return parseFloat(getComputedStyle(area).lineHeight) || 24;
}

function getCharWidth() {
    const probe = document.createElement("span");
    probe.textContent = "0";
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font:inherit;";
    area.appendChild(probe);
    const width = probe.getBoundingClientRect().width || 8;
    probe.remove();
    return width;
}

function isImageFile(file) {
    return !!file && (file.type?.startsWith("image/") || IMAGE_EXTENSION_RE.test(file.name || ""));
}

// ---------- Selection tracking ----------

// The caret is lost when the user clicks a toolbar button, so remember
// the last position inside the editor for inserting uploaded images.
function currentAreaRange() {
    const selection = getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    return area.contains(range.commonAncestorContainer) ? range : null;
}

document.addEventListener("selectionchange", () => {
    const range = currentAreaRange();
    if (range) {
        lastRange = range.cloneRange();
        if (selectedImg && range.collapsed) {
            deselectImage();
        }
    }
    scheduleCursor();
});

function getEditableRange() {
    const range = currentAreaRange();
    if (range) return range.cloneRange();
    if (lastRange) return lastRange.cloneRange();
    const end = document.createRange();
    end.selectNodeContents(area);
    end.collapse(false);
    return end;
}

function insertNodeAtRange(node, range) {
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

// ---------- Line-number gutter ----------

// Images always occupy a whole number of text lines so line numbers stay aligned.
function snapImageToLines(img) {
    const lh = getLineHeight();
    const styledHeight = parseFloat(img.style.height);
    const styledWidth = parseFloat(img.style.width);
    const baseHeight = styledHeight > 0
        ? styledHeight
        : (img.getBoundingClientRect().height || img.naturalHeight);
    if (!(baseHeight > 0)) return;

    const snappedHeight = Math.max(1, Math.round(baseHeight / lh)) * lh;
    if (styledHeight !== snappedHeight) img.style.height = `${snappedHeight}px`;

    if (!(styledWidth > 0) && img.naturalWidth && img.naturalHeight) {
        img.style.width = `${Math.round(snappedHeight * img.naturalWidth / img.naturalHeight)}px`;
    }
    img.style.objectFit = "contain";
}

// Maps each logical line (split on "\n"/<br>/blocks) to the visual row where it
// starts, since wrapped lines and tall images make the two differ.
function getLogicalLineVisualIndices() {
    const lh = getLineHeight();
    const paddingTop = parseFloat(getComputedStyle(area).paddingTop) || 12;
    const areaTop = area.getBoundingClientRect().top - area.scrollTop + paddingTop;
    const toRow = top => Math.max(0, Math.round((top - areaTop) / lh));

    const rows = [];
    let atLineStart = true;

    function charTop(textNode, offset) {
        const range = document.createRange();
        range.setStart(textNode, offset);
        range.setEnd(textNode, offset + 1);
        const rects = range.getClientRects();
        return (rects.length ? rects[0] : range.getBoundingClientRect()).top;
    }

    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.nodeValue;
            let i = 0;
            while (i < text.length) {
                if (atLineStart) {
                    rows.push(toRow(charTop(node, i)));
                    atLineStart = false;
                }
                const newline = text.indexOf("\n", i);
                if (newline === -1) break;
                atLineStart = true;
                i = newline + 1;
            }
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName.toLowerCase();
        if (tag === "br") {
            if (atLineStart) rows.push(toRow(node.getBoundingClientRect().top));
            atLineStart = true;
        } else if (tag === "img") {
            const rect = node.getBoundingClientRect();
            const lineCount = Math.max(1, Math.round((rect.height || parseFloat(node.style.height) || lh) / lh));
            const baseRow = toRow(rect.top);
            for (let i = 0; i < lineCount; i++) rows.push(baseRow + i);
            atLineStart = true;
        } else {
            const isBlock = getComputedStyle(node).display !== "inline";
            if (isBlock) atLineStart = true;
            node.childNodes.forEach(walk);
            if (isBlock) atLineStart = true;
        }
    }

    walk(area);
    return rows.length ? rows : [0];
}

function updateGutters() {
    const lh = getLineHeight();

    // Snap first so all layout writes happen before the layout reads below.
    area.querySelectorAll("img").forEach(img => {
        if (!(resizeState && img === selectedImg)) snapImageToLines(img);
    });

    const rows = getLogicalLineVisualIndices();

    // Number only rows that actually contain content.
    const contentRange = document.createRange();
    contentRange.selectNodeContents(area);
    const areaTop = area.getBoundingClientRect().top - area.scrollTop
        + (parseFloat(getComputedStyle(area).paddingTop) || 12);
    const contentRows = Math.max(1, Math.round((contentRange.getBoundingClientRect().bottom - areaTop) / lh));

    const labels = new Array(contentRows).fill("");
    rows.forEach((row, lineIndex) => {
        if (row < contentRows && !labels[row]) labels[row] = String(lineIndex + 1);
    });

    gutters.textContent = labels.join("\n");
    gutters.style.width = `${Math.max(45, String(rows.length).length * 10 + 16)}px`;

    // The gutter must be exactly as tall as the editor's scrollable area (which has extra
    // bottom padding), otherwise it can't scroll as far and its numbers drift down by
    // a row once the editor gets a scrollbar. Then re-sync the scroll position.
    gutters.style.paddingBottom = "";
    const shortfall = area.scrollHeight - gutters.scrollHeight;
    if (shortfall > 0) gutters.style.paddingBottom = `${12 + shortfall}px`;
    gutters.scrollTop = area.scrollTop;
    renderCursors();
}

let guttersRaf = null;
new ResizeObserver(() => {
    if (guttersRaf) return;
    guttersRaf = requestAnimationFrame(() => {
        guttersRaf = null;
        updateGutters();
    });
}).observe(area);

// ---------- Sanitizing ----------

// Content is shared between all viewers, so only text, <br>, <div> and
// our own uploaded images (with size styles) are allowed through.
function sanitizeHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    sanitizeChildren(template.content);
    return template.innerHTML;
}

function stripAttributes(el, keep = []) {
    for (const attr of Array.from(el.attributes)) {
        if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    }
}

function sanitizeChildren(node) {
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }

        const tag = child.tagName.toLowerCase();
        if (tag === "img") {
            if (!(child.getAttribute("src") || "").startsWith(IMAGE_URL_PREFIX)) {
                child.remove();
                continue;
            }
            const { width, height } = child.style;
            stripAttributes(child, ["src", "alt"]);
            child.style.cssText = "object-fit:contain;";
            if (width) child.style.width = width;
            if (height) child.style.height = height;
        } else if (tag === "br" || tag === "div") {
            stripAttributes(child);
            sanitizeChildren(child);
        } else {
            child.replaceWith(document.createTextNode(child.textContent));
        }
    }
}

// ---------- Remote cursors ----------

// A caret is described as an offset in a walk over the document where text
// counts by character and <br>/<img> count as 1, so every device (which holds
// the same synced content) resolves the same offset to the same place.
let myId = null;
let remoteCursors = [];
const cursorEls = new Map();
let cursorTimer = null;
let cursorsRaf = null;
let lastSentPos;
let lastContent = "";
let typingUntil = 0;
let freezeTimer = null;

// One character per position unit, matching pointToOffset/offsetToPoint.
function serializeContent() {
    let out = "";
    (function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === "BR") { out += "\u0001"; return; }
        if (node.tagName === "IMG") { out += "\u0002"; return; }
        if (isBlock(node)) out += "\u0003";
        node.childNodes.forEach(walk);
    })(area);
    return out;
}

// Returns a function mapping offsets in `oldStr` to the matching offsets in `newStr`.
function diffShift(oldStr, newStr) {
    const limit = Math.min(oldStr.length, newStr.length);
    let prefix = 0;
    while (prefix < limit && oldStr[prefix] === newStr[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < limit - prefix
        && oldStr[oldStr.length - 1 - suffix] === newStr[newStr.length - 1 - suffix]
    ) suffix++;
    const oldEnd = oldStr.length - suffix;
    const newEnd = newStr.length - suffix;
    return offset => {
        if (offset <= prefix) return offset;
        if (offset >= oldEnd) return offset + (newEnd - oldEnd);
        return prefix + Math.min(offset - prefix, newEnd - prefix);
    };
}

// After a local edit, keep other users' cursors attached to their text.
function anchorRemoteCursors() {
    const now = serializeContent();
    if (now === lastContent) return;
    const shift = diffShift(lastContent, now);
    remoteCursors = remoteCursors.map(cursor => ({ ...cursor, pos: shift(cursor.pos) }));
    lastContent = now;
}

function isBlock(node) {
    return node.tagName === "DIV" && node !== area;
}

// Each block (<div>) start counts as 1 so the end of one line and the start of an
// empty line below it are different offsets.
function unitsOf(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue.length;
    if (node.nodeType !== Node.ELEMENT_NODE) return 0;
    if (node.tagName === "BR" || node.tagName === "IMG") return 1;
    let total = isBlock(node) ? 1 : 0;
    node.childNodes.forEach(child => { total += unitsOf(child); });
    return total;
}

function pointToOffset(target, targetOffset) {
    let count = 0;
    let found = false;
    function walk(node) {
        if (found) return;
        if (node.nodeType === Node.TEXT_NODE) {
            if (node === target) { count += targetOffset; found = true; }
            else count += node.nodeValue.length;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === "BR" || node.tagName === "IMG") {
            count += 1;
            return;
        }
        if (isBlock(node)) count += 1;
        if (node === target) {
            for (let i = 0; i < targetOffset && i < node.childNodes.length; i++) {
                count += unitsOf(node.childNodes[i]);
            }
            found = true;
            return;
        }
        node.childNodes.forEach(walk);
    }
    walk(area);
    return count;
}

function offsetToPoint(offset) {
    let remaining = offset;
    let result = null;
    const indexOf = node => Array.prototype.indexOf.call(node.parentNode.childNodes, node);
    function walk(node) {
        if (result) return;
        if (node.nodeType === Node.TEXT_NODE) {
            if (remaining <= node.nodeValue.length) result = { node, offset: remaining };
            else remaining -= node.nodeValue.length;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.tagName === "BR" || node.tagName === "IMG") {
            if (remaining === 0) result = { node: node.parentNode, offset: indexOf(node) };
            else remaining -= 1;
            return;
        }
        if (isBlock(node)) {
            if (remaining === 0) {
                result = { node: node.parentNode, offset: indexOf(node) };
                return;
            }
            remaining -= 1;
            if (remaining === 0 && !node.childNodes.length) {
                result = { node, offset: 0 };
                return;
            }
        }
        node.childNodes.forEach(walk);
    }
    walk(area);
    return result || { node: area, offset: area.childNodes.length };
}

function textRect(node, start, end) {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rects = range.getClientRects();
    const rect = rects.length ? rects[0] : range.getBoundingClientRect();
    return rect.height > 0 ? rect : null;
}

// Rect of the caret itself at a DOM point (works on most text positions).
function caretRect(node, offset) {
    try {
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        const rects = range.getClientRects();
        const rect = rects.length ? rects[0] : range.getBoundingClientRect();
        return rect.height > 0 ? rect : null;
    } catch {
        return null;
    }
}

// Empty lines (<div><br></div>, lone <br>) often report a zero-size rect, so
// climb to the nearest ancestor that has real geometry.
function elementPos(el, atEnd) {
    const lh = getLineHeight();
    for (let cur = el; cur && cur !== area; cur = cur.parentElement) {
        const rect = cur.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
            return { x: atEnd ? rect.right : rect.left, y: rect.top, h: lh };
        }
    }
    const areaRect = area.getBoundingClientRect();
    const style = getComputedStyle(area);
    return {
        x: areaRect.left + (parseFloat(style.paddingLeft) || 0),
        y: areaRect.top + (parseFloat(style.paddingTop) || 0) - area.scrollTop,
        h: lh,
    };
}

// Screen position { x, y, h } of a DOM point, or null if it can't be measured.
function pointToScreen(node, offset) {
    const lh = getLineHeight();
    const fromRect = (x, rect) => ({ x, y: rect.top + rect.height / 2 - lh / 2, h: lh });

    if (node.nodeType === Node.TEXT_NODE) {
        const len = node.nodeValue.length;
        const caret = caretRect(node, offset);
        if (caret) return fromRect(caret.left, caret);
        if (offset < len) {
            const rect = textRect(node, offset, offset + 1);
            if (rect) return fromRect(rect.left, rect);
        }
        if (len > 0) {
            const at = Math.min(offset, len);
            const rect = textRect(node, at - 1, at);
            if (rect) return fromRect(rect.right, rect);
        }
        return elementPos(node.parentElement || area, false);
    }

    const child = node.childNodes[offset];
    if (child) {
        if (child.nodeType === Node.TEXT_NODE) return pointToScreen(child, 0);
        if (child.tagName !== "IMG") {
            const caret = caretRect(node, offset);
            if (caret) return fromRect(caret.left, caret);
        }
        return elementPos(child, false);
    }
    const prev = node.lastChild;
    if (prev?.nodeType === Node.TEXT_NODE) return pointToScreen(prev, prev.nodeValue.length);
    if (prev) return elementPos(prev, true);
    return elementPos(node, false);
}

function drawCursors() {
    const areaRect = area.getBoundingClientRect();
    const seen = new Set();

    for (const cursor of remoteCursors) {
        if (cursor.id === myId) continue;
        seen.add(cursor.id);

        let el = cursorEls.get(cursor.id);
        if (!el) {
            el = document.createElement("div");
            el.className = "remote-cursor";
            document.body.appendChild(el);
            cursorEls.set(cursor.id, el);
        }

        const point = offsetToPoint(cursor.pos);
        const pos = pointToScreen(point.node, point.offset);
        const visible = pos
            && pos.y + pos.h > areaRect.top && pos.y < areaRect.bottom
            && pos.x >= areaRect.left && pos.x <= areaRect.right;
        if (!visible) { el.style.display = "none"; continue; }

        el.style.setProperty("--c", cursor.color);
        el.style.left = `${pos.x}px`;
        el.style.top = `${pos.y}px`;
        el.style.height = `${pos.h}px`;
        el.style.display = "block";
    }

    for (const [id, el] of cursorEls) {
        if (!seen.has(id)) { el.remove(); cursorEls.delete(id); }
    }
}

function renderCursors() {
    // Hide other users' cursors while typing, then bring them back once idle.
    const wait = typingUntil - Date.now();
    if (wait > 0) {
        cursorEls.forEach(el => { el.style.display = "none"; });
        clearTimeout(freezeTimer);
        freezeTimer = setTimeout(renderCursors, wait + 20);
        return;
    }
    if (cursorsRaf) return;
    cursorsRaf = requestAnimationFrame(() => {
        cursorsRaf = null;
        if (typingUntil > Date.now()) renderCursors();
        else drawCursors();
    });
}

function postCursor(pos) {
    if (pos === lastSentPos) return;
    lastSentPos = pos;
    socket.send(JSON.stringify({ type: "cursor", pos }));
}

function sendCursor() {
    if (socket?.readyState !== WebSocket.OPEN) return;

    // While typing, hide our cursor for everyone; it reappears once we stop.
    const wait = typingUntil - Date.now();
    if (wait > 0) {
        postCursor(null);
        clearTimeout(cursorTimer);
        cursorTimer = setTimeout(sendCursor, wait + 50);
        return;
    }

    const range = currentAreaRange();
    postCursor(document.activeElement === area && range
        ? pointToOffset(range.startContainer, range.startOffset)
        : null);
}

function scheduleCursor() {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(sendCursor, 60);
}

area.addEventListener("focus", scheduleCursor);
area.addEventListener("blur", scheduleCursor);

// ---------- WebSocket sync ----------

let pendingRemote = null;
let pendingQuiet = false;
let pendingFrom = null;
let expectSnapshot = false;
let pendingTimer = null;
let dirty = false;
let lastEditAt = 0;

function saveSelection() {
    const selection = getSelection();
    if (!selection?.rangeCount || !area.contains(selection.anchorNode)) return null;
    const range = selection.getRangeAt(0);
    return {
        start: pointToOffset(range.startContainer, range.startOffset),
        end: pointToOffset(range.endContainer, range.endOffset),
    };
}

function restoreSelection({ start, end }) {
    const from = offsetToPoint(start);
    const to = start === end ? from : offsetToPoint(end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
}

// Small "someone is typing" indicator, shown whenever a remote edit lands.
const typingEl = document.createElement("div");
typingEl.id = "typing-indicator";
typingEl.textContent = "Someone is typing\u2026";
document.body.appendChild(typingEl);
let typingIndicatorTimer = null;

function showTypingIndicator() {
    typingEl.style.display = "block";
    clearTimeout(typingIndicatorTimer);
    typingIndicatorTimer = setTimeout(() => { typingEl.style.display = "none"; }, 1500);
}

function sameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType === Node.TEXT_NODE) return a.nodeValue === b.nodeValue;
    if (a.nodeType !== Node.ELEMENT_NODE) return true;
    if (a.tagName !== b.tagName) return false;
    if (a.tagName === "IMG") {
        return a.getAttribute("src") === b.getAttribute("src")
            && a.style.width === b.style.width
            && a.style.height === b.style.height;
    }
    if (a.childNodes.length !== b.childNodes.length) return false;
    return Array.from(a.childNodes).every((child, i) => sameNode(child, b.childNodes[i]));
}

// Edits text in place. The browser moves any caret/selection inside the node
// along with the edit, exactly like a normal keystroke would.
function patchText(node, fresh) {
    const oldText = node.nodeValue;
    const newText = fresh.nodeValue;
    const limit = Math.min(oldText.length, newText.length);
    let prefix = 0;
    while (prefix < limit && oldText[prefix] === newText[prefix]) prefix++;
    let suffix = 0;
    while (
        suffix < limit - prefix
        && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) suffix++;
    node.replaceData(prefix, oldText.length - prefix - suffix, newText.slice(prefix, newText.length - suffix));
}

// How far the matching (unchanged) run at the start and end of two node lists
// reaches. Nodes outside [start, oldEnd) are identical between old and new;
// only the nodes in between actually differ.
function commonBoundaries(oldNodes, newNodes) {
    let start = 0;
    while (start < oldNodes.length && start < newNodes.length && sameNode(oldNodes[start], newNodes[start])) start++;
    let oldEnd = oldNodes.length;
    let newEnd = newNodes.length;
    while (oldEnd > start && newEnd > start && sameNode(oldNodes[oldEnd - 1], newNodes[newEnd - 1])) {
        oldEnd--;
        newEnd--;
    }
    return { start, oldEnd, newEnd };
}

// Updates `parent` to match `fresh` touching only what differs, so unchanged
// nodes (and a caret inside them) are never recreated.
// Returns true if any node was replaced, added or removed.
function patchChildren(parent, fresh) {
    const oldNodes = Array.from(parent.childNodes);
    const newNodes = Array.from(fresh.childNodes);
    const { start, oldEnd, newEnd } = commonBoundaries(oldNodes, newNodes);

    const oldMid = oldNodes.slice(start, oldEnd);
    const newMid = newNodes.slice(start, newEnd);
    let structural = false;

    if (oldMid.length === newMid.length) {
        oldMid.forEach((oldNode, i) => {
            const newNode = newMid[i];
            if (oldNode.nodeType === Node.TEXT_NODE && newNode.nodeType === Node.TEXT_NODE) {
                patchText(oldNode, newNode);
            } else if (oldNode.tagName === "DIV" && newNode.tagName === "DIV") {
                if (patchChildren(oldNode, newNode)) structural = true;
            } else {
                parent.replaceChild(newNode, oldNode);
                structural = true;
            }
        });
    } else {
        const anchor = oldNodes[oldEnd] || null;
        oldMid.forEach(node => node.remove());
        newMid.forEach(node => parent.insertBefore(node, anchor));
        structural = true;
    }
    return structural;
}

// The top-level child of `area` (a line's <div>, or a bare text/br/img node
// for the first line before any Enter is pressed) that contains `node`.
function lineAncestor(node) {
    while (node && node.parentNode && node.parentNode !== area) node = node.parentNode;
    return node && node.parentNode === area ? node : null;
}

function currentLineNode() {
    const range = currentAreaRange();
    if (!range) return null;
    const { startContainer, startOffset } = range;
    if (startContainer === area) return lineAncestor(area.childNodes[startOffset] || area.lastChild);
    return lineAncestor(startContainer);
}

// The one line an incoming update must not touch right now: whichever line
// has the caret while we're actively typing, or the line holding the image
// currently being resized. Null means nothing needs protecting.
function protectedLineNode() {
    if (resizeState) return selectedImg ? lineAncestor(selectedImg) : null;
    if (document.activeElement === area && isActivelyEditing()) return currentLineNode();
    return null;
}

// Applies a remote version of the content without disturbing the local caret:
// text edits are patched in place; only when whole lines/images are added or
// removed is the caret re-placed by offset.
// Returns true once applied. Returns false without touching the DOM if the
// update overlaps the line we're actively editing/resizing right now -- the
// caller is expected to hold onto `text` and retry later in that case.
function applyRemote(text, quiet = false, from = null) {
    const html = sanitizeHtml(text || "");
    if (html === sanitizeHtml(area.innerHTML)) return true;

    const template = document.createElement("template");
    template.innerHTML = html;

    const editingLine = protectedLineNode();
    if (editingLine) {
        const oldNodes = Array.from(area.childNodes);
        const newNodes = Array.from(template.content.childNodes);
        const { start, oldEnd } = commonBoundaries(oldNodes, newNodes);
        const idx = oldNodes.indexOf(editingLine);
        // Nodes before `start` or from `oldEnd` on are provably untouched by
        // this update; anything else means the update reshuffled or edited
        // the region our line lives in, so it isn't safe to apply yet.
        const untouched = idx !== -1 && (idx < start || idx >= oldEnd);
        if (!untouched) return false;
    }

    const selection = document.activeElement === area ? saveSelection() : null;
    const before = serializeContent();
    const scroll = area.scrollTop;

    if (!resizeState) deselectImage();
    const structural = patchChildren(area, template.content);

    const after = serializeContent();
    const shift = diffShift(before, after);
    if (selection && structural) {
        restoreSelection({ start: shift(selection.start), end: shift(selection.end) });
    }
    // Keep everyone else's cursor attached to its text too. The author's own
    // cursor is skipped: it reports its real position itself.
    remoteCursors = remoteCursors.map(cursor =>
        cursor.id === from ? cursor : { ...cursor, pos: shift(cursor.pos) });
    lastContent = after;
    area.scrollTop = scroll;
    updateGutters();
    if (!quiet) showTypingIndicator();
    return true;
}

// Whether we currently have a line that needs protecting from incoming
// updates: the caret's line while typing, or the image's line while resizing.
function isActivelyEditing() {
    if (resizeState) return true;
    if (document.activeElement !== area || !document.hasFocus()) return false;
    return dirty || Date.now() - lastEditAt < 1500;
}

// Applies the queued update straight away unless it overlaps the line we're
// on, in which case it's retried until it no longer overlaps (or we go idle).
function flushRemote() {
    clearTimeout(pendingTimer);
    if (pendingRemote === null) return;
    const applied = applyRemote(pendingRemote, pendingQuiet, pendingFrom);
    if (!applied) {
        pendingTimer = setTimeout(flushRemote, 700);
        return;
    }
    pendingRemote = null;
}

area.addEventListener("blur", flushRemote);

function connect() {
    clearTimeout(reconnectTimer);
    if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.onclose = null;
        socket.close();
    }
    setStatus("Connecting...");
    const protocol = location.protocol === "https:" ? "wss://" : "ws://";
    const ws = new WebSocket(`${protocol}${location.host}/pastebin-ws`);
    socket = ws;

    ws.onopen = () => {
        setStatus("");
        expectSnapshot = true;
        lastSentPos = undefined; // the server has no caret for this new connection yet
        scheduleCursor();
        if (dirty) sendHtml(); // push edits made while we were offline
    };
    ws.onmessage = event => {
        const data = JSON.parse(event.data);
        if (data.type === "hello") {
            myId = data.id;
        }
        if (data.type === "cursors") {
            remoteCursors = data.cursors || [];
            renderCursors();
        }
        if (data.type === "update") {
            pendingRemote = data.text || "";
            pendingFrom = data.from || null;
            pendingQuiet = expectSnapshot; // the first update after connecting is just the initial state
            expectSnapshot = false;
            flushRemote();
        }
        if (data.type === "saved") setStatus("Saved", 1200);
        if (data.users !== undefined) userCountEl.textContent = data.users;
    };
    ws.onclose = () => {
        if (pageCaching || ws !== socket) return;
        setStatus("Offline, reconnecting...");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => ws.close();
}

// The socket only lives while the page is in use: connect when the page gets
// focus (which also fetches the latest text) and disconnect when it loses it.
function isConnected() {
    return socket && socket.readyState <= WebSocket.OPEN;
}

function goOnline() {
    if (pageCaching || isConnected()) return;
    connect();
}

function goOffline() {
    // Push any unsent edit first, then drop the connection.
    if (dirty) {
        clearTimeout(saveTimer);
        sendHtml();
    }
    clearTimeout(reconnectTimer);
    clearTimeout(pendingTimer);
    remoteCursors = [];
    drawCursors();
    if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
    }
    setStatus("");
}

window.addEventListener("focus", goOnline);
window.addEventListener("blur", goOffline);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") goOnline();
    else goOffline();
});

// Pages restored from the back/forward cache must drop their socket and
// reconnect on return, otherwise they'd show stale content.
window.addEventListener("pagehide", event => {
    if (!event.persisted) return;
    pageCaching = true;
    clearTimeout(reconnectTimer);
    socket?.close();
});

window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    pageCaching = false;
    connect();
});

function sendHtml() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    setStatus("Saving...");
    dirty = false;
    pendingRemote = null; // our version is being sent and supersedes it
    socket.send(JSON.stringify({ type: "update", text: sanitizeHtml(area.innerHTML) }));
}

area.addEventListener("input", () => {
    if (selectedImg && !area.contains(selectedImg)) {
        deselectImage();
    }
    updateGutters();
    dirty = true;
    lastEditAt = Date.now();
    typingUntil = Date.now() + 600;
    anchorRemoteCursors();
    sendCursor();
    setStatus("Syncing...");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(sendHtml, 300);
});

// ---------- Image resizing ----------

const handles = [
    createHandle("corner", "both"),
    createHandle("edge-right", "width"),
    createHandle("edge-bottom", "height"),
];
const [cornerHandle, rightHandle, bottomHandle] = handles;

function createHandle(className, mode) {
    const handle = document.createElement("div");
    handle.className = `resize-handle ${className}`;
    handle.addEventListener("pointerdown", event => startResize(event, mode, handle));
    document.body.appendChild(handle);
    return handle;
}

function positionHandles() {
    if (!selectedImg) return;
    const rect = selectedImg.getBoundingClientRect();

    cornerHandle.style.left = `${rect.right - 6}px`;
    cornerHandle.style.top = `${rect.bottom - 6}px`;
    rightHandle.style.left = `${rect.right - 4}px`;
    rightHandle.style.top = `${rect.top + rect.height / 2 - 14}px`;
    bottomHandle.style.left = `${rect.left + rect.width / 2 - 14}px`;
    bottomHandle.style.top = `${rect.bottom - 4}px`;
}

function selectImage(img) {
    if (selectedImg === img) return;
    deselectImage();
    selectedImg = img;
    img.classList.add("img-selected");
    positionHandles();
    handles.forEach(h => { h.style.display = "block"; });

    const selection = getSelection();
    if (selection) {
        const range = document.createRange();
        range.selectNode(img);
        selection.removeAllRanges();
        selection.addRange(range);
    }
}

function deselectImage() {
    if (!selectedImg) return;
    selectedImg.classList.remove("img-selected");
    selectedImg = null;
    handles.forEach(h => { h.style.display = "none"; });
}

// Live size readout shown in the center of the image while resizing.
const sizeBadge = document.createElement("div");
sizeBadge.id = "size-badge";
document.body.appendChild(sizeBadge);

function updateSizeBadge() {
    if (!selectedImg) return;
    const rect = selectedImg.getBoundingClientRect();
    sizeBadge.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
    sizeBadge.style.left = `${rect.left + rect.width / 2}px`;
    sizeBadge.style.top = `${rect.top + rect.height / 2}px`;
    sizeBadge.style.display = "block";
}

function startResize(event, mode, handle) {
    if (!selectedImg) return;
    event.preventDefault();
    event.stopPropagation();

    const rect = selectedImg.getBoundingClientRect();
    resizeState = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startWidth: rect.width,
        startHeight: rect.height,
        aspectRatio: selectedImg.naturalWidth / selectedImg.naturalHeight || 1,
        charWidth: getCharWidth(),
    };
    updateSizeBadge();
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", onResizeMove);
    handle.addEventListener("pointerup", endResize);
}

// Height snaps to whole lines; width-only resizing snaps to whole characters.
function onResizeMove(event) {
    if (!resizeState || !selectedImg) return;
    const lh = getLineHeight();
    const { mode, startX, startY, startWidth, startHeight, aspectRatio, charWidth } = resizeState;

    let newHeight = startHeight;
    let newWidth = startWidth;

    if (mode !== "width") {
        const lines = Math.max(1, Math.round((startHeight + event.clientY - startY) / lh));
        newHeight = lines * lh;
    }
    if (mode === "width") {
        const chars = Math.max(1, Math.round((startWidth + event.clientX - startX) / charWidth));
        newWidth = chars * charWidth;
    } else if (mode === "both") {
        newWidth = Math.round(newHeight * aspectRatio);
    }

    selectedImg.style.height = `${Math.max(lh, newHeight)}px`;
    selectedImg.style.width = `${Math.max(4, newWidth)}px`;
    selectedImg.style.objectFit = "contain";

    positionHandles();
    updateSizeBadge();
    updateGutters();
}

function endResize(event) {
    const handle = event.currentTarget;
    handle.releasePointerCapture(event.pointerId);
    handle.removeEventListener("pointermove", onResizeMove);
    handle.removeEventListener("pointerup", endResize);
    resizeState = null;
    sizeBadge.style.display = "none";
    notifyChange();
}

document.addEventListener("click", event => {
    const target = event.target;
    if (target.tagName === "IMG" && area.contains(target)) {
        selectImage(target);
    } else if (!handles.includes(target)) {
        deselectImage();
    }
});

area.addEventListener("scroll", () => {
    gutters.scrollTop = area.scrollTop;
    positionHandles();
    renderCursors();
});
window.addEventListener("resize", () => {
    positionHandles();
    renderCursors();
});

// ---------- Image upload / paste / drop ----------

function insertImageAtRange(url, range) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "pasted image";
    img.onload = () => {
        snapImageToLines(img);
        notifyChange();
    };
    insertNodeAtRange(img, range);

    // The image is a block, so it already ends its line. Drop the line break
    // that used to end that line, or it renders as an empty row under the image.
    const next = img.nextSibling;
    if (next?.nodeName === "BR") {
        next.remove();
    } else if (next?.nodeType === Node.TEXT_NODE && next.nodeValue.startsWith("\n")) {
        next.nodeValue = next.nodeValue.slice(1);
    }
}

async function uploadImage(file, range) {
    setStatus("Uploading image...");
    const formData = new FormData();
    formData.append("image", file, file.name || "pasted-image.png");
    try {
        const response = await fetch("/pastebin-image", { method: "POST", body: formData });
        if (!response.ok) throw new Error("Upload failed");
        const data = await response.json();
        insertImageAtRange(data.url, range);
        setStatus("");
    } catch {
        setStatus("Image upload failed", 2000);
    }
}

function rangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    const pos = document.caretPositionFromPoint?.(x, y);
    if (!pos) return null;
    const range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.collapse(true);
    return range;
}

// navigator.clipboard only exists on HTTPS or localhost; over plain http (e.g. a LAN IP)
// it is undefined, so fall back to the legacy execCommand copy.
async function copyText(text) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch { /* fall through to the legacy path */ }
    }
    const temp = document.createElement("textarea");
    temp.value = text;
    temp.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(temp);
    temp.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ignored */ }
    temp.remove();
    return ok;
}

$("copy-btn").addEventListener("click", async () => {
    const ok = await copyText(area.innerText);
    setStatus(ok ? "Copied to clipboard" : "Copy failed", 1200);
});

$("upload-btn").addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (isImageFile(file)) uploadImage(file, getEditableRange());
    fileInput.value = "";
});

// Paste as plain text so foreign formatting never enters the shared document.
area.addEventListener("paste", event => {
    const clipboard = event.clipboardData;
    for (const item of clipboard?.items ?? []) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (isImageFile(file)) {
            event.preventDefault();
            uploadImage(file, getEditableRange());
            return;
        }
    }
    const text = clipboard?.getData("text/plain");
    if (text) {
        event.preventDefault();
        insertNodeAtRange(document.createTextNode(text), getEditableRange());
        notifyChange();
    }
});

["dragenter", "dragover"].forEach(type => {
    area.addEventListener(type, event => {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        event.preventDefault();
        area.classList.add("drag-over");
    });
});

area.addEventListener("dragleave", () => area.classList.remove("drag-over"));

area.addEventListener("drop", event => {
    event.preventDefault();
    area.classList.remove("drag-over");
    const files = Array.from(event.dataTransfer?.files ?? []);
    const images = files.filter(isImageFile);

    if (images.length) {
        const dropRange = rangeFromPoint(event.clientX, event.clientY) || getEditableRange();
        images.forEach(file => uploadImage(file, dropRange.cloneRange()));
    } else if (files.length) {
        setStatus("Dropped file isn't a recognized image", 2000);
    }
});

connect();
updateGutters();