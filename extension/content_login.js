console.log('WxClaw Helper Login Script Loaded');

const WS_URL = 'ws://127.0.0.1:18790';
let ws;
let retryInterval = 5000;
let isConnecting = false;
let lastCaptureAt = 0;

function sendLoginScreenshot() {
    const now = Date.now();
    if (now - lastCaptureAt < 60000) return;
    const target = document.querySelector('.login_wechat');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    lastCaptureAt = now;
    chrome.runtime.sendMessage({
        type: 'capture_login_wechat',
        rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height
        },
        dpr: window.devicePixelRatio || 1
    }, (resp) => {
        if (chrome.runtime.lastError) {
            console.error('Capture message failed:', chrome.runtime.lastError.message);
            return;
        }
        if (!resp || !resp.ok || !resp.base64) {
            return;
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'login_screenshot',
                base64: resp.base64
            }));
        }
    });
}

function connect() {
    if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) return;
    isConnecting = true;

    try {
        ws = new WebSocket(WS_URL);
    } catch (e) {
        console.error("Failed to create WebSocket:", e);
        isConnecting = false;
        setTimeout(connect, retryInterval);
        return;
    }

    ws.onopen = () => {
        console.log('Connected to Daemon from Login Page');
        isConnecting = false;
        
        // Report login_needed status
        ws.send(JSON.stringify({ type: 'status', status: 'login_needed', url: window.location.href }));
        sendLoginScreenshot();

        // Heartbeat
        setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 10000);
    };

    ws.onmessage = (event) => {
        // Login page might not need to handle updates, but we log it
        try {
            const message = JSON.parse(event.data);
            console.log('Received message:', message);
        } catch (e) {
            console.error('Error parsing message', e);
        }
    };

    ws.onclose = () => {
        console.log('Disconnected from Daemon. Reconnecting in 5s...');
        isConnecting = false;
        ws = null;
        setTimeout(connect, retryInterval);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };
}

// Lifecycle Hooks
document.addEventListener('visibilitychange', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    
    if (document.visibilityState === 'hidden') {
        ws.send(JSON.stringify({ type: 'status', status: 'background' }));
    } else {
        ws.send(JSON.stringify({ type: 'status', status: 'login_needed', url: window.location.href }));
        sendLoginScreenshot();
    }
});

window.addEventListener('pagehide', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'status', status: 'closing' }));
    }
});

// Start connection
connect();
