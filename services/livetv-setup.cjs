"use strict";
// Nuvio Live: add an IPTV provider from a phone. While the TV's "add provider" screen is open,
// this serves a small form on the home network (the TV shows its address as a QR code), and keeps
// what the phone sends until the app reads it over the loopback plugin service. Same shape as
// custom-poster-config.cjs. Idea from NuvioPlusIPTV's PhoneInputServer (GPL-3.0).
//
// Nothing here is logged, and the details only live in memory until the app has read them.
var http = require("http");

var FIRST_PORT = 2712;
var LAST_PORT = 2715;
var IDLE_MS = 60000;
var MAX_SESSION_MS = 10 * 60 * 1000;
var MAX_BODY_BYTES = 16384;
var MAX_FIELD_LENGTH = 2048;

var session = null;
var listener = null;
var idleTimer = null;
var maxTimer = null;

function escape(value) {
  return String(value || "").replace(/[&<>"']/g, function (char) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}

function reply(response, status, body, html) {
  response.writeHead(status, {
    "Content-Type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    // The phone only makes a couple of requests; don't keep sockets open on the TV.
    Connection: "close",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-" +
      (session ? session.token : "") +
      "'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'"
  });
  response.end(html ? body : JSON.stringify(body));
}

function clearTimers() {
  clearTimeout(idleTimer);
  clearTimeout(maxTimer);
  idleTimer = null;
  maxTimer = null;
}

function stop(token) {
  if (!session || token !== session.token) return false;
  clearTimers();
  session = null;
  if (listener) {
    listener.close();
    // Also drop the phone's kept-alive connection, so the session really ends here.
    if (typeof listener.closeAllConnections === "function") listener.closeAllConnections();
  }
  listener = null;
  return true;
}

function renew() {
  clearTimeout(idleTimer);
  var token = session.token;
  idleTimer = setTimeout(function () {
    stop(token);
  }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function scriptValue(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function field(value) {
  return typeof value === "string" ? value.trim().slice(0, MAX_FIELD_LENGTH + 1) : "";
}

function isHttpUrl(value) {
  return /^https?:\/\/[^\s/]+/i.test(value);
}

// Only a first check so the phone can say what's wrong; the app checks the details properly.
function readSubmission(body) {
  var type = body && body.type === "m3u" ? "m3u" : body && body.type === "xtream" ? "xtream" : "";
  if (!type) return { error: "invalid_type" };
  var name = field(body.name);
  if (type === "xtream") {
    var server = field(body.server);
    var username = field(body.username);
    var password =
      typeof body.password === "string" ? body.password.slice(0, MAX_FIELD_LENGTH + 1) : "";
    if (!server) return { error: "missing_server" };
    var linkHasLogin = /[?&]username=[^&]+/i.test(server) && /[?&]password=[^&]+/i.test(server);
    if (!linkHasLogin && (!username || !password)) return { error: "missing_login" };
    if (
      [name, server, username, password].some(function (v) {
        return v.length > MAX_FIELD_LENGTH;
      })
    )
      return { error: "too_long" };
    return {
      submission: { type: type, name: name, server: server, username: username, password: password }
    };
  }
  var url = field(body.url);
  var epgUrl = field(body.epgUrl);
  if (!isHttpUrl(url)) return { error: "invalid_url" };
  if (epgUrl && !isHttpUrl(epgUrl)) return { error: "invalid_epg_url" };
  if (
    [name, url, epgUrl].some(function (v) {
      return v.length > MAX_FIELD_LENGTH;
    })
  )
    return { error: "too_long" };
  return { submission: { type: type, name: name, url: url, epgUrl: epgUrl } };
}

function page(current) {
  var labels = current.labels;
  function label(key) {
    return escape(labels[key] || key);
  }
  function input(id, type, key, mode) {
    return (
      '<label for="' +
      id +
      '">' +
      label(key) +
      '</label><input id="' +
      id +
      '" type="' +
      type +
      '" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"' +
      (mode ? ' inputmode="' + mode + '"' : "") +
      ">"
    );
  }
  var errors = {};
  [
    "missing_server",
    "missing_login",
    "invalid_url",
    "invalid_epg_url",
    "too_long",
    "invalid_type",
    "connection"
  ].forEach(function (key) {
    errors[key] = labels["error_" + key] || labels.error_connection || "Error";
  });
  return (
    '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    label("title") +
    "</title><style>" +
    "body{margin:0;padding:20px;background:#101114;color:#eee;font:17px system-ui,-apple-system,Roboto,sans-serif}" +
    "main{max-width:560px;margin:auto}h1{font-size:22px;margin:0 0 6px}p{color:#aaa;line-height:1.45;margin:6px 0 16px}" +
    ".tabs{display:flex;gap:8px;margin:14px 0 18px}.tabs button{flex:1;margin:0;background:#1d1e23;color:#ddd;border:1px solid #333}" +
    ".tabs button[aria-selected=true]{background:#fff;color:#111}" +
    "label{display:block;margin:14px 0 6px;color:#ccc;font-size:15px}" +
    "input{box-sizing:border-box;width:100%;padding:13px;font:16px system-ui,sans-serif;background:#1b1b1f;color:#fff;border:1px solid #444;border-radius:10px}" +
    ".hint{font-size:14px;color:#888;margin:6px 0 0}.show{display:flex;align-items:center;gap:8px;margin-top:10px;color:#aaa;font-size:15px}.show input{width:auto}" +
    "button{padding:14px 22px;font:600 17px system-ui,sans-serif;border:0;border-radius:10px;background:#fff;color:#111}" +
    "#send{width:100%;margin-top:22px}#status{min-height:1.4em;margin-top:16px;font-size:16px}" +
    ".ok{color:#7f7}.bad{color:#f88}[hidden]{display:none}" +
    "</style><main><h1>" +
    label("title") +
    "</h1><p>" +
    label("subtitle") +
    '</p><div class="tabs" role="tablist"><button id="tab-xtream" role="tab" aria-selected="true">' +
    label("tab_xtream") +
    '</button><button id="tab-m3u" role="tab" aria-selected="false">' +
    label("tab_m3u") +
    "</button></div>" +
    input("name", "text", "name") +
    '<section id="xtream">' +
    input("server", "url", "server", "url") +
    '<p class="hint">' +
    label("server_hint") +
    "</p>" +
    input("username", "text", "username") +
    input("password", "password", "password") +
    '<label class="show"><input id="show" type="checkbox">' +
    label("show_password") +
    '</label></section><section id="m3u" hidden>' +
    input("url", "url", "playlist_url", "url") +
    input("epg", "url", "epg_url", "url") +
    '<p class="hint">' +
    label("epg_hint") +
    '</p></section><button id="send">' +
    label("send") +
    '</button><p id="status" role="status"></p></main><script nonce="' +
    current.token +
    '">(function(){var type="xtream",errors=' +
    scriptValue(errors) +
    ",sent=" +
    scriptValue(labels.sent || "Sent. Look at your TV.") +
    ",sending=" +
    scriptValue(labels.sending || "Sending…") +
    ';function $(id){return document.getElementById(id)}function select(next){type=next;$("tab-xtream").setAttribute("aria-selected",String(next==="xtream"));$("tab-m3u").setAttribute("aria-selected",String(next==="m3u"));$("xtream").hidden=next!=="xtream";$("m3u").hidden=next!=="m3u"}$("tab-xtream").onclick=function(){select("xtream")};$("tab-m3u").onclick=function(){select("m3u")};$("show").onchange=function(){$("password").type=this.checked?"text":"password"};function say(text,ok){var s=$("status");s.textContent=text;s.className=ok?"ok":"bad"}$("send").onclick=function(){var body=type==="xtream"?{type:type,name:$("name").value,server:$("server").value,username:$("username").value,password:$("password").value}:{type:type,name:$("name").value,url:$("url").value,epgUrl:$("epg").value};var button=this;button.disabled=true;say(sending,true);fetch("api/submit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(v){return{ok:r.ok,v:v}})}).then(function(r){button.disabled=false;if(r.ok){say(sent,true)}else{say(errors[r.v&&r.v.error]||errors.connection,false)}}).catch(function(){button.disabled=false;say(errors.connection,false)})}})();</script></html>'
  );
}

function handle(request, response) {
  var current = session;
  if (!current) return reply(response, 404, { error: "expired" });
  var prefix = "/" + current.token + "/";
  var route = String(request.url || "").split("?")[0];
  if (route.indexOf(prefix) !== 0) return reply(response, 404, { error: "not_found" });
  if (request.headers.origin && request.headers.origin !== "http://" + request.headers.host)
    return reply(response, 403, { error: "origin" });
  route = route.slice(prefix.length);
  if (request.method === "GET" && route === "") return reply(response, 200, page(current), true);
  if (request.method !== "POST" || route !== "api/submit")
    return reply(response, 404, { error: "not_found" });
  var size = 0;
  var chunks = [];
  request.on("data", function (chunk) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  });
  request.on("end", function () {
    if (session !== current) return reply(response, 410, { error: "expired" });
    if (size > MAX_BODY_BYTES) return reply(response, 413, { error: "too_long" });
    var body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (_) {
      return reply(response, 400, { error: "invalid_type" });
    }
    var result = readSubmission(body);
    if (result.error) return reply(response, 400, { error: result.error });
    current.submission = result.submission;
    current.revision += 1;
    reply(response, 200, { status: "sent" });
  });
  request.on("error", function () {});
}

function lanAddress() {
  var address = "";
  try {
    var interfaces = require("os").networkInterfaces();
    var names = Object.keys(interfaces).sort(function (a, b) {
      // Prefer wired/wireless adapters over anything else (VPN, docker, …).
      var rank = function (name) {
        return /^(eth|wlan|en|wl)/i.test(name) ? 0 : 1;
      };
      return rank(a) - rank(b);
    });
    names.some(function (name) {
      return interfaces[name].some(function (entry) {
        if (!entry.internal && (entry.family === "IPv4" || entry.family === 4)) {
          address = entry.address;
          return true;
        }
        return false;
      });
    });
  } catch (_) {
    // The app falls back to webapis.network.getIp().
  }
  return address;
}

function start(payload) {
  // The code is part of the address on the phone, so it is short enough to type (see the app).
  if (!/^[a-z0-9]{12,64}$/.test((payload && payload.token) || ""))
    return Promise.reject(new Error("Invalid token"));
  if (session) stop(session.token);
  var current = { token: payload.token, labels: {}, revision: 0, submission: null };
  Object.keys(payload.labels || {})
    .slice(0, 40)
    .forEach(function (key) {
      current.labels[key] = String(payload.labels[key]).slice(0, 1024);
    });
  session = current;
  return new Promise(function (resolve, reject) {
    function bind(port) {
      var server = http.createServer(handle);
      server.maxConnections = 8;
      server.setTimeout(15000);
      server.requestTimeout = 15000;
      server.headersTimeout = 10000;
      server.once("error", function (error) {
        if (session !== current) return reject(new Error("Superseded"));
        if (error.code === "EADDRINUSE" && port < LAST_PORT) return bind(port + 1);
        stop(current.token);
        reject(error);
      });
      server.listen(port, "0.0.0.0", function () {
        if (session !== current) {
          server.close();
          return reject(new Error("Superseded"));
        }
        listener = server;
        renew();
        maxTimer = setTimeout(function () {
          stop(current.token);
        }, MAX_SESSION_MS);
        if (maxTimer.unref) maxTimer.unref();
        resolve({ port: port, address: lanAddress(), revision: 0 });
      });
    }
    bind(FIRST_PORT);
  });
}

function read(token) {
  if (!session || session.token !== token) return null;
  renew();
  return { revision: session.revision, submission: session.submission };
}

module.exports = { start: start, stop: stop, read: read, readSubmission: readSubmission };
