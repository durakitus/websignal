const max_file_size = 104857600;
const ws_proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
const socket = new WebSocket(`${ws_proto}://${window.location.host}/ws`);
socket.binaryType = "arraybuffer";

const dom_messages_list = document.getElementById('messages');
const dom_user_count = document.getElementById('user_count');
const dom_username_display = document.getElementById('username');
const dom_message_input = document.getElementById('message_input');
const dom_file_input = document.getElementById('file_input');
const dom_send_button = document.getElementById('send_btn');
const dom_attachment_button = document.getElementById('custom_file_btn');
const dom_status_indicator = document.getElementById('status_indicator');
const dom_overlay_container = document.getElementById('user_list_overlay');
const dom_active_users_list = document.getElementById('active_users');
const dom_chat_scroll_area = document.getElementById('chat_area');

let current_local_username = null;
const active_incoming_streams = new Map();

const scroll_to_bottom = () => dom_chat_scroll_area.scrollTo({ top: dom_chat_scroll_area.scrollHeight, behavior: 'smooth' });

window.visualViewport?.addEventListener('resize', scroll_to_bottom);

const synchronize_identity = (force_new = false) => {
    let stored_name = force_new ? null : localStorage.getItem('username');
    while (!stored_name) {
        const input = prompt(force_new ? "NAME TAKEN. CHOOSE ANOTHER:" : "ENTER YOUR NAME");
        if (input === null) return window.location.href = "about:blank";
        stored_name = input.trim();
    }
    current_local_username = stored_name;
    localStorage.setItem('username', stored_name);
    document.body.style.visibility = 'visible';
    dom_message_input.focus();
    socket.send(JSON.stringify({ type: 'set_name', username: current_local_username }));
};

socket.onopen = () => { dom_status_indicator.classList.add('online'); synchronize_identity(); };
socket.onclose = () => dom_status_indicator.classList.remove('online');

socket.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const id_length = view.getUint8(0);
        const stream_id = new TextDecoder().decode(event.data.slice(1, 1 + id_length));
        const chunk_data = event.data.slice(1 + id_length);

        const stream_context = active_incoming_streams.get(stream_id);
        if (stream_context) {
            stream_context.controller.enqueue(new Uint8Array(chunk_data));
            stream_context.received += chunk_data.byteLength;

            const progress_label = stream_context.ui_ref.querySelector('.byte_counter');
            if (progress_label) {
                progress_label.textContent = `LOADING: ${Math.round((stream_context.received / stream_context.size) * 100)}%`;
            }

            if (stream_context.received >= stream_context.size) {
                stream_context.controller.close();
                active_incoming_streams.delete(stream_id);
            }
        }
        return;
    }

    const parsed_data = JSON.parse(event.data);
    const { type } = parsed_data;

    if (type === 'identity') {
        current_local_username = parsed_data.username;
        dom_username_display.textContent = `ID: ${current_local_username}`;
        localStorage.setItem('username', current_local_username);
        dom_message_input.focus();
    } else if (type === 'error') {
        synchronize_identity(true);
    } else if (type === 'user_count') {
        dom_user_count.textContent = `ONLINE: ${parsed_data.count}`;
    } else if (type === 'user_list') {
        dom_active_users_list.innerHTML = '';
        parsed_data.users.forEach(user_entry => {
            const list_item = document.createElement('li');
            list_item.textContent = user_entry === current_local_username ? `@${user_entry}` : user_entry;
            dom_active_users_list.appendChild(list_item);
        });
    } else if (type === 'file_meta') {
        let stream_controller;
        const readable_stream = new ReadableStream({ start(c) { stream_controller = c; } });
        const ui_node = render_streaming_placeholder(parsed_data);
        
        active_incoming_streams.set(parsed_data.stream_id, {
            ...parsed_data,
            received: 0,
            controller: stream_controller,
            ui_ref: ui_node
        });

        new Response(readable_stream).blob().then(final_blob => {
            const final_node = build_file_node({
                filename: parsed_data.filename,
                data: final_blob,
                mimetype: parsed_data.mimetype
            });
            ui_node.querySelector('.file_message_content').replaceChildren(final_node);
            ui_node.classList.remove('transferring');
            scroll_to_bottom();
        });
    } else if (type === 'message') {
        render_ui_element(parsed_data);
    }
};

const dispatch_text_message = () => {
    const input_text = dom_message_input.value.trim();
    if (!input_text) return;
    socket.send(JSON.stringify({ type: 'message', text: input_text, user: current_local_username }));
    dom_message_input.value = '';
    dom_message_input.focus();
};

dom_send_button.onclick = dispatch_text_message;
dom_message_input.onkeydown = (e) => e.key === 'Enter' && dispatch_text_message();
dom_attachment_button.onclick = () => dom_file_input.click();

dom_user_count.onclick = (e) => { e.stopPropagation(); dom_overlay_container.classList.toggle('visible'); };
dom_overlay_container.onclick = () => dom_overlay_container.classList.remove('visible');
dom_message_input.onfocus = () => setTimeout(scroll_to_bottom, 300);

dom_file_input.onchange = async () => {
    for (const selected_file of dom_file_input.files) {
        if (selected_file.size > max_file_size) continue;

        const stream_id = crypto.randomUUID();
        const id_bytes = new TextEncoder().encode(stream_id);

        socket.send(JSON.stringify({
            type: 'file_meta',
            stream_id,
            filename: selected_file.name,
            mimetype: selected_file.type,
            user: current_local_username,
            size: selected_file.size
        }));

        const reader = selected_file.stream().getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const packet = new Uint8Array(1 + id_bytes.length + value.length);
            packet[0] = id_bytes.length;
            packet.set(id_bytes, 1);
            packet.set(value, 1 + id_bytes.length);
            socket.send(packet);
        }
    }
    dom_file_input.value = '';
};

const render_streaming_placeholder = (payload) => {
    const is_own = payload.user === current_local_username;
    const li = document.createElement('li');
    li.className = `message ${is_own ? 'user' : 'other'} transferring`;
    li.innerHTML = `
        <div class="meta">${payload.user} # ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="file_message_content">
            <div class="generic_file_bubble">${payload.filename}<span class="byte_counter">CONNECTING...</span></div>
        </div>
    `;
    dom_messages_list.appendChild(li);
    scroll_to_bottom();
    return li;
};

const render_ui_element = (payload) => {
    const is_own = payload.user === current_local_username;
    const li = document.createElement('li');
    li.className = `message ${is_own ? 'user' : 'other'}`;
    li.innerHTML = `<div class="meta">${payload.user} & ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>`;

    if (payload.type === 'message') {
        const span = document.createElement('span');
        span.textContent = payload.text;
        li.appendChild(span);
    } else {
        li.appendChild(build_file_node(payload));
    }

    dom_messages_list.appendChild(li);
    if (dom_chat_scroll_area.scrollHeight - dom_chat_scroll_area.scrollTop - dom_chat_scroll_area.clientHeight < 150 || is_own) {
        scroll_to_bottom();
    }
};

const build_file_node = (file_payload) => {
    const url = URL.createObjectURL(file_payload.data);
    const wrapper = document.createElement('div');
    wrapper.className = 'file_message_content';
    let media;
    
    const ext = file_payload.filename.split('.').pop().toLowerCase();
    const mime = (file_payload.mimetype || '').toLowerCase();

    if (['mkv', 'mp4', 'webm'].includes(ext) || mime.includes('video')) {
        media = document.createElement('video');
        media.src = url;
        media.controls = true;
        media.className = 'native_video_player';
    } else if (['mp3', 'ogg', 'flac'].includes(ext) || mime.includes('audio')) {
        media = document.createElement('audio');
        media.src = url;
        media.controls = true;
        media.className = 'native_audio_player';
    } else if (['jpg', 'png', 'webp'].includes(ext) || mime.includes('image')) {
        media = document.createElement('img');
        media.src = url;
        media.className = 'file_image_bubble';
    } else if (['md', 'txt', 'log', 'py', 'rs', 'kt'].includes(ext) || mime.includes('text')) {
        media = document.createElement('pre');
        media.className = ['py', 'rs', 'kt'].includes(ext) ? 'code_preview' : 'text_preview';
        file_payload.data.text().then(text => media.textContent = text);
    } else {
        media = document.createElement('div');
        media.className = 'generic_file_bubble';
        const size = file_payload.data.size;
        media.textContent = `${file_payload.filename} @ ${size > 1048576 ? (size / 1048576).toFixed(2) + ' MB' : (size / 1024).toFixed(2) + ' KB'}`;
    }

    wrapper.appendChild(media);

    if (media.tagName !== 'AUDIO' && media.tagName !== 'VIDEO') {
        const a = document.createElement('a');
        a.className = 'file_download_btn';
        a.href = url;
        a.download = file_payload.filename;
        a.textContent = 'DOWNLOAD';
        wrapper.appendChild(a);
    }

    return wrapper;
};
