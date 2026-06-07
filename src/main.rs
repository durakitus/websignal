use anyhow::Result;
use axum::{
    Router,
    extract::{
        State,
        connect_info::ConnectInfo,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::HeaderMap,
    response::{Html, IntoResponse, Redirect, Response},
    routing::get,
};
use axum_server::Handle;
use axum_server::tls_rustls::RustlsConfig;
use clap::Parser;
use dashmap::DashMap;
use futures_util::{SinkExt, StreamExt};
use get_if_addrs::get_if_addrs;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use rcgen::generate_simple_self_signed;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{self, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{broadcast, mpsc},
    time::sleep,
};
use uuid::Uuid;

const HTML_DATA: &str = include_str!("../web/index.html");
const CSS_DATA: &str = include_str!("../web/style.css");
const JS_DATA: &str = include_str!("../web/script.js");
const JSON_DATA: &str = include_str!("../web/manifest.json");

#[derive(Parser)]
struct Cli {}

#[derive(Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
enum ChatPayload {
    #[serde(rename = "message")]
    Message { text: String, user: String },
    #[serde(rename = "set_name")]
    SetName { username: String },
    #[serde(rename = "identity")]
    Identity { username: String },
    #[serde(rename = "user_count")]
    UserCount { count: usize },
    #[serde(rename = "user_list")]
    UserList { users: Vec<String> },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "file_meta")]
    FileMeta {
        stream_id: String,
        filename: String,
        mimetype: String,
        user: String,
        size: usize,
    },
}

struct AppState {
    broadcast_tx: broadcast::Sender<Message>,
    user_mapping: DashMap<Uuid, String>,
    shutdown_tx: mpsc::Sender<()>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _args = Cli::parse();
    let (broadcast_tx, _) = broadcast::channel(1024);
    let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);

    let shared_state = Arc::new(AppState {
        broadcast_tx,
        user_mapping: DashMap::new(),
        shutdown_tx: shutdown_tx.clone(),
    });

    // Dynamically gather current network addresses
    let network_ips: Vec<IpAddr> = match get_if_addrs() {
        Ok(interfaces) => interfaces
            .into_iter()
            .filter(|iface| !iface.is_loopback() && iface.ip().is_ipv4())
            .map(|iface| iface.ip())
            .collect(),
        Err(_) => vec![],
    };

    // Map discovered network addresses into the certificate subjects
    let mut cert_subjects = vec!["websignal.local".to_string()];
    for ip in &network_ips {
        cert_subjects.push(ip.to_string());
    }

    // Generate the certificate matching the current network topology
    let cert = generate_simple_self_signed(cert_subjects)?;
    let tls_config = RustlsConfig::from_der(
        vec![cert.cert.der().to_vec()],
        cert.signing_key.serialize_der(),
    )
    .await?;

    let bind_all = IpAddr::V4(Ipv4Addr::new(0, 0, 0, 0));
    let https_addr = SocketAddr::new(bind_all, 8443);
    let http_addr = SocketAddr::new(bind_all, 8080);

    println!("\n[WebSignal] Secure Service Started...");

    tokio::spawn(async move {
        let redirect_app =
            Router::new().fallback(move |headers: HeaderMap, uri: axum::http::Uri| async move {
                let host_raw = headers
                    .get("host")
                    .and_then(|h| h.to_str().ok())
                    .unwrap_or("websignal.local");
                let host = host_raw.split(':').next().unwrap_or("websignal.local");
                let path = uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/");
                Redirect::permanent(&format!("https://{}:8443{}", host, path))
            });
        if let Ok(l) = TcpListener::bind(http_addr).await {
            let _ = axum::serve(l, redirect_app).await;
        }
    });

    let app = Router::new()
        .route("/", get(serve_index))
        .route("/style.css", get(serve_css))
        .route("/script.js", get(serve_js))
        .route("/manifest.json", get(serve_json))
        .route("/ws", get(ws_handler))
        .with_state(shared_state.clone());

    if let Ok(mdns) = ServiceDaemon::new() {
        for ip in &network_ips {
            let service_info = ServiceInfo::new(
                "_websignal._tcp.local.",
                "WebSignal",
                "websignal.local.",
                ip.to_string(),
                8443,
                HashMap::new(),
            )
            .expect("mDNS Configuration Failure")
            .enable_addr_auto();

            if let Err(e) = mdns.register(service_info) {
                eprintln!("[!] mDNS registration failed for {}: {}", ip, e);
            } else {
                println!("[*] mDNS active: websignal.local -> {}", ip);
            }
        }
    }

    let handle = Handle::new();
    let shutdown_handle = handle.clone();
    let timer_state = shared_state.clone();
    let timer_tx = shutdown_tx.clone();

    tokio::spawn(async move {
        let mut countdown = 30;
        loop {
            if !timer_state.user_mapping.is_empty() {
                print!("\r[+] Device connected. Discovery timer stopped.                      \n");
                let _ = io::stdout().flush();
                break;
            }
            if countdown <= 0 {
                println!("\r[!] Timeout reached. Shutting down.                              ");
                let _ = timer_tx.send(()).await;
                break;
            }
            print!("\rWaiting for devices: {:02}", countdown);
            let _ = io::stdout().flush();
            sleep(Duration::from_secs(1)).await;
            countdown -= 1;
        }
    });

    tokio::spawn(async move {
        let _ = shutdown_rx.recv().await;
        shutdown_handle.graceful_shutdown(Some(Duration::from_millis(100)));
    });

    axum_server::bind_rustls(https_addr, tls_config)
        .handle(handle)
        .serve(app.into_make_service_with_connect_info::<SocketAddr>())
        .await?;

    Ok(())
}

async fn serve_index() -> Html<&'static str> {
    Html(HTML_DATA)
}
async fn serve_css() -> Response {
    Response::builder()
        .header("content-type", "text/css")
        .body(CSS_DATA.into())
        .unwrap()
}
async fn serve_js() -> Response {
    Response::builder()
        .header("content-type", "text/javascript")
        .body(JS_DATA.into())
        .unwrap()
}
async fn serve_json() -> Response {
    Response::builder()
        .header("content-type", "application/json")
        .body(JSON_DATA.into())
        .unwrap()
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    _connect_info: ConnectInfo<SocketAddr>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_connection(socket, state))
}

async fn handle_connection(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();
    let mut broadcast_rx = state.broadcast_tx.subscribe();
    let session_id = Uuid::new_v4();
    let state_ref = state.clone();

    let (feedback_tx, mut feedback_rx) = mpsc::channel::<Message>(10);

    let mut send_stream = tokio::spawn(async move {
        loop {
            tokio::select! {
                Ok(msg) = broadcast_rx.recv() => {
                    if sender.send(msg).await.is_err() { break; }
                }
                Some(msg) = feedback_rx.recv() => {
                    if sender.send(msg).await.is_err() { break; }
                }
            }
        }
    });

    let mut recv_stream = tokio::spawn(async move {
        while let Some(Ok(message)) = receiver.next().await {
            match message {
                Message::Text(t) => {
                    if let Ok(p) = serde_json::from_str::<ChatPayload>(&t) {
                        match p {
                            ChatPayload::SetName { username } => {
                                let name_exists = state_ref.user_mapping.iter().any(|entry| {
                                    entry.value().to_lowercase() == username.to_lowercase()
                                });
                                if name_exists {
                                    let err = ChatPayload::Error {
                                        message: "Username already taken".to_string(),
                                    };
                                    let _ = feedback_tx
                                        .send(Message::Text(
                                            serde_json::to_string(&err).unwrap().into(),
                                        ))
                                        .await;
                                } else {
                                    state_ref.user_mapping.insert(session_id, username.clone());
                                    let _ = state_ref.broadcast_tx.send(Message::Text(
                                        serde_json::to_string(&ChatPayload::Identity { username })
                                            .unwrap()
                                            .into(),
                                    ));
                                    broadcast_user_list(&state_ref);
                                }
                            }
                            _ => {
                                let _ = state_ref.broadcast_tx.send(Message::Text(t));
                            }
                        }
                    }
                }
                Message::Binary(r) => {
                    let _ = state_ref.broadcast_tx.send(Message::Binary(r));
                }
                _ => {}
            }
        }
    });

    tokio::select! { _ = &mut send_stream => recv_stream.abort(), _ = &mut recv_stream => send_stream.abort() };
    state.user_mapping.remove(&session_id);
    broadcast_user_list(&state);
    if state.user_mapping.is_empty() {
        println!("\r[-] All identified devices disconnected. Shutting down the server.");
        let _ = state.shutdown_tx.send(()).await;
    }
}

fn broadcast_user_list(state: &AppState) {
    let users: Vec<String> = state
        .user_mapping
        .iter()
        .map(|e| e.value().clone())
        .collect();
    let count = users.len();
    let _ = state.broadcast_tx.send(Message::Text(
        serde_json::to_string(&ChatPayload::UserList { users })
            .unwrap()
            .into(),
    ));
    let _ = state.broadcast_tx.send(Message::Text(
        serde_json::to_string(&ChatPayload::UserCount { count })
            .unwrap()
            .into(),
    ));
}
