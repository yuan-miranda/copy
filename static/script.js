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

// ---------- WebSocket sync ----------

function connect() {
    setStatus("Connecting...");
    const protocol = location.protocol === "https:" ? "wss://" : "ws://";
    socket = new WebSocket(`${protocol}${location.host}/pastebin-ws`);

    socket.onopen = () => setStatus("");
    socket.onmessage = event => {
        const data = JSON.parse(event.data);
        // Never overwrite the editor while the user is typing in it.
        if (data.type === "update" && document.activeElement !== area) {
            deselectImage();
            area.innerHTML = sanitizeHtml(data.text || "");
            updateGutters();
        }
        if (data.type === "saved") setStatus("Saved", 1200);
        if (data.users !== undefined) userCountEl.textContent = data.users;
    };
    socket.onclose = () => {
        if (pageCaching) return;
        setStatus("Offline, reconnecting...");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 2000);
    };
    socket.onerror = () => socket.close();
}

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
    socket.send(JSON.stringify({ type: "update", text: sanitizeHtml(area.innerHTML) }));
}

area.addEventListener("input", () => {
    if (selectedImg && !area.contains(selectedImg)) {
        deselectImage();
    }
    updateGutters();
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
    updateGutters();
}

function endResize(event) {
    const handle = event.currentTarget;
    handle.releasePointerCapture(event.pointerId);
    handle.removeEventListener("pointermove", onResizeMove);
    handle.removeEventListener("pointerup", endResize);
    resizeState = null;
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
});
window.addEventListener("resize", positionHandles);

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