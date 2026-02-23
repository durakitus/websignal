const max_file_size_mb = 100;
const ws_protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const ws_url = `${ws_protocol}://${window.location.hostname}:${window.location.port}/ws`;
const ws = new WebSocket(ws_url);
ws.binaryType = "arraybuffer";

const dom_ul = document.getElementById('messages');
const dom_count = document.getElementById('user_count');
const dom_user = document.getElementById('username');
const dom_input = document.getElementById('message_input');
const dom_file = document.getElementById('file_input');
const dom_send = document.getElementById('send_btn');
const dom_file_btn = document.getElementById('custom_file_btn');
const dom_status = document.getElementById('status_indicator');
const dom_progress = document.getElementById('transfer_progress');
const dom_overlay = document.getElementById('user_list_overlay');
const dom_active_list = document.getElementById('active_users');

let current_username = null;
let pending_file_meta = null;

const sync_identity = () => {
    let name = localStorage.getItem('username');
    while (!name) {
        const input = prompt("ENTER DISPLAY NAME");
        if (input === null) {
            window.location.href = "about:blank";
            return;
        }
        name = input.trim();
    }
    current_username = name;
    localStorage.setItem('username', name);
    document.body.style.visibility = 'visible';
    dom_input.focus();
    ws.send(JSON.stringify({ type: 'set_name', username: current_username }));
};

ws.onopen = () => {
    dom_status.classList.add('online');
    sync_identity();
};

ws.onclose = () => {
    dom_status.classList.remove('online');
};

ws.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
        if (pending_file_meta) {
            const blob = new Blob([event.data], { type: pending_file_meta.mimetype });
            render_ui_bubble({ ...pending_file_meta, data: blob, type: 'file' });
            pending_file_meta = null;
            dom_progress.value = 0;
        }
        return;
    }

    const data = JSON.parse(event.data);

    if (data.type === 'identity') {
        current_username = data.username;
        dom_user.textContent = `ID: ${current_username}`;
        localStorage.setItem('username', current_username);
        dom_input.focus();
    } else if (data.type === 'user_count') {
        dom_count.textContent = `ONLINE: ${data.count}`;
    } else if (data.type === 'user_list') {
        dom_active_list.innerHTML = '';
        data.users.forEach(user => {
            const li = document.createElement('li');
            li.textContent = user === current_username ? `${user} (YOU)` : user;
            dom_active_list.appendChild(li);
        });
    } else if (data.type === 'file_meta') {
        pending_file_meta = data;
        dom_progress.value = 50;
    } else if (data.type === 'message') {
        render_ui_bubble(data);
    }
};

const dispatch_message = () => {
    const text = dom_input.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: 'message', text, user: current_username }));
    dom_input.value = '';
    dom_input.focus();
};

dom_send.onclick = dispatch_message;
dom_input.onkeydown = (e) => { e.key === 'Enter' && dispatch_message() };
dom_file_btn.onclick = () => dom_file.click();
dom_count.onclick = () => dom_overlay.classList.toggle('visible');

dom_file.onchange = async () => {
    for (const file of dom_file.files) {
        if (file.size > max_file_size_mb * 1024 * 1024) continue;
        dom_progress.value = 25;
        ws.send(JSON.stringify({
            type: 'file_meta',
            filename: file.name,
            mimetype: file.type,
            user: current_username
        }));
        ws.send(await file.arrayBuffer());
    }
    dom_file.value = '';
};

const render_ui_bubble = (data) => {
    const is_me = data.user === current_username;
    const li = document.createElement('li');
    li.className = `message ${is_me ? 'user' : 'other'}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<div class="meta">${data.user} • ${time}</div>`;

    if (data.type === 'message') {
        const span = document.createElement('span');
        span.textContent = data.text;
        li.appendChild(span);
    } else {
        li.appendChild(build_media_node(data));
    }

    dom_ul.appendChild(li);
    
    const chat_area = document.getElementById('chat_area');
    const threshold = 150;
    const isNearBottom = chat_area.scrollHeight - chat_area.scrollTop - chat_area.clientHeight < threshold;

    if (isNearBottom) {
        chat_area.scrollTo({
            top: chat_area.scrollHeight,
            behavior: 'smooth'
        });
    }
};

const build_media_node = (data) => {
    const container = document.createElement('div');
    container.className = 'file_message';
    const url = URL.createObjectURL(data.data);
    const bubble = document.createElement('div');
    bubble.className = 'file_message_content';
    let node;
    const mime = data.mimetype;

    if (mime.startsWith('image/')) {
        node = document.createElement('img');
        node.src = url;
        node.className = 'file_image_fullbubble';
    } else if (mime.startsWith('video/')) {
        node = document.createElement('video');
        node.src = url;
        node.controls = true;
        node.className = 'native_video_player';
    } else if (mime.startsWith('audio/')) {
        node = document.createElement('audio');
        node.src = url;
        node.controls = true;
        node.className = 'native_audio_player';
    } else if (mime.startsWith('text/') || mime === 'application/json') {
        node = document.createElement('pre');
        node.className = 'text_preview';
        data.data.text().then(t => node.textContent = t);
    } else {
        node = document.createElement('div');
        node.className = 'generic_file_bubble';
        
        const size = data.data.size;
        const sizeStr = size > 1024 * 1024 
            ? `${(size / (1024 * 1024)).toFixed(2)} MB` 
            : `${(size / 1024).toFixed(2)} KB`;
            
        node.textContent = `${data.filename} • ${sizeStr}`;
    }

    bubble.appendChild(node);

    if (!mime.startsWith('audio/') && !mime.startsWith('video/')) {
        const dl = document.createElement('a');
        dl.className = 'file_download_btn';
        dl.href = url;
        dl.download = data.filename;
        dl.textContent = '⤓';
        bubble.appendChild(dl);
    }

    container.appendChild(bubble);
    return container;
};

const render_system_text = (text) => {
    const li = document.createElement('li');
    li.className = 'system';
    li.textContent = text;
    dom_ul.appendChild(li);
    const chat_area = document.getElementById('chat_area');
    chat_area.scrollTop = chat_area.scrollHeight;
};
