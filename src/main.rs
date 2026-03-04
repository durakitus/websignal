use anyhow::{Context, Result};
use axum::{
    Router,
    extract::{
        State,
        connect_info::ConnectInfo,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::{Html, IntoResponse, Response},
    routing::get,
};
use clap::Parser;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use get_if_addrs::get_if_addrs;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use qrcode::QrCode;
use qrcode::render::unicode;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{self, Write},
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};
use tokio::sync::{broadcast, mpsc};

const HTML_DATA: &str = include_str!("../web/index.html");
const CSS_DATA: &str = include_str!("../web/style.css");
const JS_DATA: &str = include_str!("../web/script.js");
const JSON_DATA: &str = include_str!("../web/manifest.json");

#[derive(Parser)]
#[command(
    name = "websignal",
    version,
    about = "A locally hosted web app for messaging and file sharing.",
    long_about = "An offline, local messaging and file sharing web app. Clients can access it through a standard web browser, and connect to a group chat for local messaging and sharing files over LAN."
)]
struct Cli {}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
enum ChatPayload {
    #[serde(rename = "set_name")]
    SetName { username: String },
    #[serde(rename = "identity")]
    Identity { username: String },
    #[serde(rename = "message")]
    Message { text: String, user: String },
    #[serde(rename = "file_meta")]
    FileMeta {
        filename: String,
        mimetype: String,
        user: String,
    },
    #[serde(rename = "file")]
    File {
        filename: String,
        mimetype: String,
        data: String,
        user: String,
    },
    #[serde(rename = "user_count")]
    UserCount { count: usize },
    #[serde(rename = "user_list")]
    UserList { users: Vec<String> },
}

struct AppState {
    user_mapping: DashMap<String, String>,
    broadcast_tx: broadcast::Sender<Message>,
    shutdown_tx: mpsc::Sender<()>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = Cli::parse();

    let (broadcast_tx, _) = broadcast::channel::<Message>(1024);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);

    let shared_state = Arc::new(AppState {
        user_mapping: DashMap::new(),
        broadcast_tx,
        shutdown_tx,
    });

    let local_ip = match get_if_addrs() {
        Ok(ifaces) => ifaces
            .into_iter()
            .find(|iface| !iface.is_loopback() && iface.ip().is_ipv4())
            .map(|iface| iface.ip().to_string())
            .unwrap_or_else(|| "0.0.0.0".to_string()),
        Err(_) => "0.0.0.0".to_string(),
    };

    if local_ip != "0.0.0.0" {
        let url = format!("http://{}:8080", local_ip);
        if let Ok(code) = QrCode::new(url.as_bytes()) {
            let scannable_data = code
                .render::<unicode::Dense1x2>()
                .dark_color(unicode::Dense1x2::Light)
                .light_color(unicode::Dense1x2::Dark)
                .build();
            println!("\n[WebSignal] SCAN TO CONNECT:\n{}\n", scannable_data);
        }
    }

    let ip_for_mdns = local_ip.clone();
    tokio::spawn(async move {
        if ip_for_mdns != "0.0.0.0" {
            let _ = setup_mdns_responder(ip_for_mdns).await.map_err(|e| {
                eprintln!("[!] multicast suppressed: {}", e);
            });
        }
    });

    let app_router = Router::new()
        .route("/", get(serve_index))
        .route("/style.css", get(serve_style))
        .route("/script.js", get(serve_script))
        .route("/manifest.json", get(serve_manifest))
        .route("/ws", get(ws_entry))
        .with_state(shared_state.clone());

    let server_listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .context("[!] Port 8080 is busy")?;

    println!("[WebSignal] Discovery mode active");

    let timer_state = shared_state.clone();
    tokio::spawn(async move {
        for i in (1..=30).rev() {
            if !timer_state.user_mapping.is_empty() {
                return;
            }
            print!("\rWaiting for devices: {:02}", i);
            let _ = io::stdout().flush();
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        if timer_state.user_mapping.is_empty() {
            println!("\r[!] No devices connected. Shutting down.");
            let _ = timer_state.shutdown_tx.send(()).await;
        }
    });

    axum::serve(
        server_listener,
        app_router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        shutdown_rx.recv().await;
    })
    .await
    .context("Server execution failed")?;

    Ok(())
}

async fn setup_mdns_responder(local_ip: String) -> Result<()> {
    let mdns_handler = ServiceDaemon::new().context("Failed to create multicast daemon")?;
    let service_type = "_http._tcp.local.";
    let instance_name = "websignal";
    let host_name = "websignal.local.";
    let port = 8080;

    let mut properties = HashMap::new();
    properties.insert("path".to_string(), "/".to_string());

    let service_info = ServiceInfo::new(
        service_type,
        instance_name,
        host_name,
        &local_ip,
        port,
        properties,
    )
    .context("Failed to create multicast service info")?;

    mdns_handler
        .register(service_info)
        .context("Failed to register multicast service")?;

    Ok(())
}

async fn serve_index() -> Html<&'static str> {
    Html(HTML_DATA)
}

async fn serve_style() -> impl IntoResponse {
    Response::builder()
        .header("content-type", "text/css")
        .body(CSS_DATA.to_string())
        .unwrap()
}

async fn serve_script() -> impl IntoResponse {
    Response::builder()
        .header("content-type", "application/javascript")
        .body(JS_DATA.to_string())
        .unwrap()
}

async fn serve_manifest() -> impl IntoResponse {
    Response::builder()
        .header("content-type", "application/json")
        .body(JSON_DATA.to_string())
        .unwrap()
}

async fn ws_entry(
    ws_upgrade: WebSocketUpgrade,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    State(shared_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws_upgrade.on_upgrade(move |socket| handle_connection(socket, remote_addr, shared_state))
}

async fn handle_connection(
    socket: WebSocket,
    remote_addr: SocketAddr,
    shared_state: Arc<AppState>,
) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let mut broadcast_rx = shared_state.broadcast_tx.subscribe();
    let client_ip = remote_addr.ip().to_string();
    let (direct_tx, mut direct_rx) = mpsc::channel::<Message>(16);

    let mut send_stream = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(msg) = direct_rx.recv() => {
                    if ws_sender.send(msg).await.is_err() { break; }
                }
                Ok(msg) = broadcast_rx.recv() => {
                    if ws_sender.send(msg).await.is_err() { break; }
                }
                else => break,
            }
        }
    });

    let state_ref = shared_state.clone();
    let ip_ref = client_ip.clone();
    let mut recv_stream = tokio::spawn(async move {
        let mut active_file_meta: Option<ChatPayload> = None;

        while let Some(Ok(ws_msg)) = ws_receiver.next().await {
            match ws_msg {
                Message::Text(raw_text) => {
                    if let Ok(incoming) = serde_json::from_str::<ChatPayload>(&raw_text) {
                        match incoming {
                            ChatPayload::SetName { username } => {
                                let first_identified = state_ref.user_mapping.is_empty();
                                let assigned_name = state_ref
                                    .user_mapping
                                    .entry(ip_ref.clone())
                                    .or_insert(username)
                                    .clone();

                                if first_identified {
                                    println!("\r[+] Device identified. Session locked.");
                                }

                                let identity = ChatPayload::Identity {
                                    username: assigned_name,
                                };
                                let _ = direct_tx
                                    .send(Message::Text(
                                        serde_json::to_string(&identity).unwrap().into(),
                                    ))
                                    .await;

                                let count = ChatPayload::UserCount {
                                    count: state_ref.user_mapping.len(),
                                };
                                let _ = state_ref.broadcast_tx.send(Message::Text(
                                    serde_json::to_string(&count).unwrap().into(),
                                ));

                                let users: Vec<String> = state_ref
                                    .user_mapping
                                    .iter()
                                    .map(|entry| entry.value().clone())
                                    .collect();
                                let list_payload = ChatPayload::UserList { users };
                                let _ = state_ref.broadcast_tx.send(Message::Text(
                                    serde_json::to_string(&list_payload).unwrap().into(),
                                ));
                            }
                            ChatPayload::Message { .. } => {
                                let _ = state_ref.broadcast_tx.send(Message::Text(raw_text));
                            }
                            ChatPayload::FileMeta { .. } => {
                                active_file_meta = Some(incoming);
                            }
                            _ => {}
                        }
                    }
                }
                Message::Binary(raw_bytes) => {
                    if let Some(meta) = active_file_meta.take() {
                        let _ = state_ref
                            .broadcast_tx
                            .send(Message::Text(serde_json::to_string(&meta).unwrap().into()));
                        let _ = state_ref.broadcast_tx.send(Message::Binary(raw_bytes));
                    }
                }
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = (&mut send_stream) => recv_stream.abort(),
        _ = (&mut recv_stream) => send_stream.abort(),
    };

    shared_state.user_mapping.remove(&client_ip);
    if shared_state.user_mapping.is_empty() {
        println!("\r[-] All identified devices disconnected. Shutting down the server.");
        let _ = shared_state.shutdown_tx.send(()).await;
    } else {
        let users: Vec<String> = shared_state
            .user_mapping
            .iter()
            .map(|entry| entry.value().clone())
            .collect();
        let list_payload = ChatPayload::UserList { users };
        let _ = shared_state.broadcast_tx.send(Message::Text(
            serde_json::to_string(&list_payload).unwrap().into(),
        ));

        let count = ChatPayload::UserCount {
            count: shared_state.user_mapping.len(),
        };
        let _ = shared_state
            .broadcast_tx
            .send(Message::Text(serde_json::to_string(&count).unwrap().into()));
    }
}
