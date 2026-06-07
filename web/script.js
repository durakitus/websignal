const max_file_size_mb = 100 * 1024 * 1024;
const websocket_protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const websocket_url = `${websocket_protocol}://${window.location.hostname}:${window.location.port}/ws`;
const socket = new WebSocket(websocket_url);
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

const scroll_to_bottom = () => {
    dom_chat_scroll_area.scrollTo({
        top: dom_chat_scroll_area.scrollHeight,
        behavior: 'smooth'
    });
};

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        scroll_to_bottom();
    });
}

const synchronize_identity = (force_new = false) => {
    let stored_name = force_new ? null : localStorage.getItem('username');
    while (!stored_name) {
        const user_prompt_input = prompt(force_new ? "NAME TAKEN. CHOOSE ANOTHER:" : "ENTER DISPLAY NAME");
        if (user_prompt_input === null) {
            window.location.href = "about:blank";
            return;
        }
        stored_name = user_prompt_input.trim();
    }
    current_local_username = stored_name;
    localStorage.setItem('username', stored_name);
    document.body.style.visibility = 'visible';
    dom_message_input.focus();
    socket.send(JSON.stringify({ type: 'set_name', username: current_local_username }));
};

socket.onopen = () => {
    dom_status_indicator.classList.add('online');
    synchronize_identity();
};

socket.onclose = () => {
    dom_status_indicator.classList.remove('online');
};

socket.onmessage = async (event) => {
    if (event.data instanceof ArrayBuffer) {
        const view = new DataView(event.data);
        const id_length = view.getUint8(0);
        const decoder = new TextDecoder();
        const stream_id = decoder.decode(event.data.slice(1, 1 + id_length));
        const chunk_data = event.data.slice(1 + id_length);

        const stream_context = active_incoming_streams.get(stream_id);
        if (stream_context) {
            stream_context.controller.enqueue(new Uint8Array(chunk_data));
            stream_context.received += chunk_data.byteLength;

            const progress_label = stream_context.ui_ref.querySelector('.byte_counter');
            if (progress_label) {
                const percentage = Math.round((stream_context.received / stream_context.size) * 100);
                progress_label.textContent = `LOADING: ${percentage}%`;
            }

            if (stream_context.received >= stream_context.size) {
                stream_context.controller.close();
                active_incoming_streams.delete(stream_id);
            }
        }
        return;
    }

    const parsed_data = JSON.parse(event.data);

    if (parsed_data.type === 'identity') {
        current_local_username = parsed_data.username;
        dom_username_display.textContent = `ID: ${current_local_username}`;
        localStorage.setItem('username', current_local_username);
        dom_message_input.focus();
    } else if (parsed_data.type === 'error') {
        synchronize_identity(true);
    } else if (parsed_data.type === 'user_count') {
        dom_user_count.textContent = `ONLINE: ${parsed_data.count}`;
    } else if (parsed_data.type === 'user_list') {
        dom_active_users_list.innerHTML = '';
        parsed_data.users.forEach(user_entry => {
            const list_item = document.createElement('li');
            list_item.textContent = user_entry === current_local_username ? `${user_entry} — YOU` : user_entry;
            dom_active_users_list.appendChild(list_item);
        });
    } else if (parsed_data.type === 'file_meta') {
        let stream_controller;
        const readable_stream = new ReadableStream({
            start(controller) {
                stream_controller = controller;
            }
        });

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
            const content_wrapper = ui_node.querySelector('.file_message_content');
            content_wrapper.replaceChildren(final_node);
            ui_node.classList.remove('transferring');
            scroll_to_bottom();
        });
    } else if (parsed_data.type === 'message') {
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
dom_message_input.onkeydown = (keyboard_event) => { keyboard_event.key === 'Enter' && dispatch_text_message() };
dom_attachment_button.onclick = () => dom_file_input.click();

dom_user_count.onclick = (click_event) => {
    click_event.stopPropagation();
    dom_overlay_container.classList.toggle('visible');
};

dom_overlay_container.onclick = () => {
    dom_overlay_container.classList.remove('visible');
};

dom_message_input.onfocus = () => {
    setTimeout(scroll_to_bottom, 300);
};

dom_file_input.onchange = async () => {
    for (const selected_file of dom_file_input.files) {
        if (selected_file.size > max_file_size_mb) continue;

        const stream_id = crypto.randomUUID();
        const id_bytes = new TextEncoder().encode(stream_id);

        socket.send(JSON.stringify({
            type: 'file_meta',
            stream_id: stream_id,
            filename: selected_file.name,
            mimetype: selected_file.type || 'application/octet-stream',
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
    const is_own_message = payload.user === current_local_username;
    const message_list_item = document.createElement('li');
    message_list_item.className = `message ${is_own_message ? 'user' : 'other'} transferring`;
    const timestamp_string = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    message_list_item.innerHTML = `
        <div class="meta">${payload.user} • ${timestamp_string}</div>
        <div class="file_message_content">
            <div class="generic_file_bubble">
                ${payload.filename}
                <span class="byte_counter">CONNECTING...</span>
            </div>
        </div>
    `;
    dom_messages_list.appendChild(message_list_item);
    scroll_to_bottom();
    return message_list_item;
};

const render_ui_element = (payload) => {
    const is_own_message = payload.user === current_local_username;
    const message_list_item = document.createElement('li');
    message_list_item.className = `message ${is_own_message ? 'user' : 'other'}`;
    const timestamp_string = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    message_list_item.innerHTML = `<div class="meta">${payload.user} • ${timestamp_string}</div>`;

    if (payload.type === 'message') {
        const text_container = document.createElement('span');
        text_container.textContent = payload.text;
        message_list_item.appendChild(text_container);
    } else {
        message_list_item.appendChild(build_file_node(payload));
    }

    dom_messages_list.appendChild(message_list_item);
    
    const scroll_threshold = 150;
    const is_near_bottom = dom_chat_scroll_area.scrollHeight - dom_chat_scroll_area.scrollTop - dom_chat_scroll_area.clientHeight < scroll_threshold;

    if (is_near_bottom || is_own_message) {
        scroll_to_bottom();
    }
};

const build_file_node = (file_payload) => {
    const object_resource_url = URL.createObjectURL(file_payload.data);
    const content_wrapper = document.createElement('div');
    content_wrapper.className = 'file_message_content';
    let media_element;
    
    const file_extension = file_payload.filename.split('.').pop().toLowerCase();
    const mime_type_string = (file_payload.mimetype || '').toLowerCase();

    const video_extensions = ['mp4', 'mkv', 'webm', 'avi', 'mov'];
    const audio_extensions = ['mp3', 'm4a', 'ogg', 'flac', 'wav'];
    const image_extensions = ['jpg', 'png', 'webp', 'bmp', 'svg'];
    const text_extensions = ['md', 'txt', 'log', 'prop', 'cfg'];
    const code_extensions = ['py', 'rs', 'kt', 'rb', 'cr'];

    if (video_extensions.includes(file_extension) || mime_type_string.includes('video')) {
        media_element = document.createElement('video');
        media_element.src = object_resource_url;
        media_element.controls = true;
        media_element.className = 'native_video_player';
    } else if (audio_extensions.includes(file_extension) || mime_type_string.includes('audio')) {
        media_element = document.createElement('audio');
        media_element.src = object_resource_url;
        media_element.controls = true;
        media_element.className = 'native_audio_player';
    } else if (image_extensions.includes(file_extension) || mime_type_string.includes('image')) {
        media_element = document.createElement('img');
        media_element.src = object_resource_url;
        media_element.className = 'file_image_fullbubble';
    } else if (code_extensions.includes(file_extension)) {
        media_element = document.createElement('pre');
        media_element.className = 'code_preview';
        file_payload.data.text().then(extracted_text => media_element.textContent = extracted_text);
    } else if (text_extensions.includes(file_extension) || mime_type_string.includes('text')) {
        media_element = document.createElement('pre');
        media_element.className = 'text_preview';
        file_payload.data.text().then(extracted_text => media_element.textContent = extracted_text);
    } else {
        media_element = document.createElement('div');
        media_element.className = 'generic_file_bubble';
        const raw_byte_size = file_payload.data.size;
        const formatted_size_string = raw_byte_size > 1024 * 1024 
            ? `${(raw_byte_size / (1024 * 1024)).toFixed(2)} MB` 
            : `${(raw_byte_size / 1024).toFixed(2)} KB`;
        media_element.textContent = `${file_payload.filename} • ${formatted_size_string}`;
    }

    content_wrapper.appendChild(media_element);

    const is_streaming_player = media_element.tagName === 'AUDIO' || media_element.tagName === 'VIDEO';
    if (!is_streaming_player) {
        const download_anchor = document.createElement('a');
        download_anchor.className = 'file_download_btn';
        download_anchor.href = object_resource_url;
        download_anchor.download = file_payload.filename;
        download_anchor.textContent = 'DOWNLOAD';
        content_wrapper.appendChild(download_anchor);
    }

    return content_wrapper;
};
