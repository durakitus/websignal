# WebSignal

> A web application based on a local server that runs from the command line.

## Overview
WebSignal is a standalone server web app: when executed, it runs a server on the device, serving its built-in webpage as an app. It hosts a LAN group chat with the capability to share files among those who have joined the chat. You can view common media files on the chat, but you can download any file shared here.


## Features
- **Group chatting:** Inspired by software like Zapya or Softros LAN Messenger, it offers a zero-install alternative based on group chatting.
- **File Previewing:** On chat, you can view the content of shared files without necessarily having to download them. This works for common types of media such as video, audio, images, and even text files, but it still supports sharing any kind of file on the group chat.
- **Downloading:** Ultimately, you can download the files you need among the ones shared in-chat through LAN or WLAN networks.

## Build
To build this from source, clone the repo:

```
git clone https://github.com/durakitus/websignal.git
cd websignal
cargo build --release
```

## Usage
Since this is primarily a web app, just triggered through the CLI, you simply run `websignal` on the command line. The tool starts the server in discovery mode for 30 seconds, closing automatically if no one connects. Additionally, it closes the server instantly if everyone disconnects — i.e., closes the page on their browser — to save resources, since it's designed to run even on constrained environments such as less powerful smartphones using Termux. You can access it through http://websignal.local:8080 if your device has the capabilities to use Multicast DNS — essentially every modern device does — or you can simply use your device's IP address on the Wi-Fi network as in http://<ip_address>:8080, which can be a common access point — meaning, that both the server and the clients are connected to it — or your own device's hotspot.

Run `websignal -h` — or `cargo run -- -h` if you don't have it in your `PATH` yet — for details on the functionality, if you decide to build it locally.
