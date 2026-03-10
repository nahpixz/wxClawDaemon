(function() {
    try {
        console.log('WxClaw Inject: Attempting to click reload button...');
        let reloadLink = document.querySelector('.qrcode_login_reload');
        if (!reloadLink) {
            const iframe = document.querySelector('#wx_reg > iframe');
            if (iframe) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    reloadLink = doc.querySelector('.qrcode_login_reload');
                } catch(e) {
                    // Cross-origin iframe access might fail, but we are in page context so usually same-origin for this frame
                }
            }
        }
        if (reloadLink) {
            reloadLink.click();
            console.log('WxClaw Inject: Clicked reload button.');
        } else {
            console.log('WxClaw Inject: Reload button not found.');
        }
    } catch(e) {
        console.error('WxClaw Inject: Failed to click reload via injected script', e);
    }
})();
