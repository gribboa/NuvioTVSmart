"use strict";
// Nuvio Live: a pass-through for IPTV requests the app can't make itself (a provider that sends
// no CORS headers, or one that wants a particular User-Agent). Loopback only (plugin-http.cjs
// checks that), http/https only, streamed so a large guide file isn't held in memory. Nothing is
// logged: provider links carry the account's username and password.
var MAX_REDIRECTS = 5;
var TIMEOUT_MS = 30000;

function fail(response, status, error) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify({ returnValue: false, error: error }));
}

function parseTarget(value) {
  try {
    var parsed = new (require("url").URL)(String(value || ""));
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function forward(target, userAgent, redirectsLeft, request, response) {
  var transport = require(target.protocol === "https:" ? "https" : "http");
  var headers = { Accept: "*/*", Connection: "close" };
  if (userAgent) headers["User-Agent"] = userAgent;
  var upstream = transport.request(
    target,
    {
      method: "GET",
      headers: headers,
      // Many IPTV panels use self-signed or expired certificates; the app accepts them too.
      rejectUnauthorized: false
    },
    function (upstreamResponse) {
      var status = upstreamResponse.statusCode || 502;
      var location = upstreamResponse.headers.location;
      if (status >= 300 && status < 400 && location) {
        upstreamResponse.resume();
        if (redirectsLeft <= 0) return fail(response, 502, "too_many_redirects");
        var next = parseTarget(new (require("url").URL)(location, target).toString());
        if (!next) return fail(response, 502, "bad_redirect");
        return forward(next, userAgent, redirectsLeft - 1, request, response);
      }
      var outHeaders = {
        "Content-Type": upstreamResponse.headers["content-type"] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "X-Upstream-Status",
        "X-Upstream-Status": String(status),
        "Cache-Control": "no-store"
      };
      if (upstreamResponse.headers["content-encoding"])
        outHeaders["Content-Encoding"] = upstreamResponse.headers["content-encoding"];
      response.writeHead(status, outHeaders);
      upstreamResponse.pipe(response);
      upstreamResponse.on("error", function () {
        response.destroy();
      });
    }
  );
  upstream.setTimeout(TIMEOUT_MS, function () {
    upstream.destroy(new Error("timeout"));
  });
  upstream.on("error", function () {
    fail(response, 502, "network");
  });
  request.on("close", function () {
    if (!response.writableEnded) upstream.destroy();
  });
  upstream.end();
}

// GET /livetv-proxy?url=<link>&ua=<user agent>
function handle(request, response) {
  var query;
  try {
    query = new (require("url").URL)(request.url, "http://127.0.0.1").searchParams;
  } catch (_) {
    return fail(response, 400, "bad_request");
  }
  var target = parseTarget(query.get("url"));
  if (!target) return fail(response, 400, "bad_url");
  forward(target, String(query.get("ua") || "").slice(0, 512), MAX_REDIRECTS, request, response);
}

module.exports = { handle: handle };
