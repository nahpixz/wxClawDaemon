chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'capture_login_wechat') {
        return false;
    }
    captureAndCrop(sender, message).then((base64) => {
        sendResponse({ ok: true, base64 });
    }).catch((error) => {
        console.error('capture_login_wechat failed:', error);
        sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
});

async function captureAndCrop(sender, message) {
    const senderWindowId = sender?.tab?.windowId;
    const rect = normalizeRect(message?.rect);
    const dpr = Number(message?.dpr) > 0 ? Number(message.dpr) : 1;
    const dataUrl = await chrome.tabs.captureVisibleTab(senderWindowId, { format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    const imageBitmap = await createImageBitmap(blob);
    const sx = Math.max(0, Math.floor(rect.left * dpr));
    const sy = Math.max(0, Math.floor(rect.top * dpr));
    const sw = Math.max(1, Math.floor(rect.width * dpr));
    const sh = Math.max(1, Math.floor(rect.height * dpr));
    const safeSw = Math.min(sw, imageBitmap.width - sx);
    const safeSh = Math.min(sh, imageBitmap.height - sy);
    const canvas = new OffscreenCanvas(Math.max(1, safeSw), Math.max(1, safeSh));
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imageBitmap, sx, sy, safeSw, safeSh, 0, 0, safeSw, safeSh);
    const croppedBlob = await canvas.convertToBlob({ type: 'image/png' });
    const ab = await croppedBlob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    return uint8ToBase64(bytes);
}

function normalizeRect(rect) {
    const left = Number(rect?.left) || 0;
    const top = Number(rect?.top) || 0;
    const width = Number(rect?.width) || 1;
    const height = Number(rect?.height) || 1;
    return { left, top, width, height };
}

function uint8ToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}
