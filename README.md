# Camera viewer

Login-protected live view of 4 RTSP camera channels: 1, 2 or all 4 at once.
Works on phones too. No npm packages needed. Requires Node 18+ and ffmpeg.

Browsers can't play RTSP, so for each channel being watched the server runs
`ffmpeg` to repackage the stream into HLS (no re-encoding). Streams start on
demand and stop 60s after nobody is watching.

Camera URLs are built as:

    rtsp://<CAM_HOST>/ch<N>.sdp?user=<CAM_USER>&pwd=<CAM_PWD>    (N = 1..4)

Adjust `rtspUrl()` in `server.js` if your camera uses a different format.

## Run

    APP_PASS='a-strong-password' CAM_HOST=192.168.0.10:554 CAM_USER=... CAM_PWD=... node server.js

Open http://localhost:8080 and log in (default user `admin`).

## Config (env vars)

| Var | Default | |
|---|---|---|
| APP_USER | admin | login username |
| APP_PASS | – | **required**, login password |
| CAM_HOST | – | **required**, camera/DVR `host:port` |
| CAM_USER / CAM_PWD | empty | camera credentials |
| PORT | 8080 | |
| HOST | 0.0.0.0 | `127.0.0.1` when behind a reverse proxy |
| TRUST_PROXY | off | `1` behind a reverse proxy (real client IP, Secure cookies) |
| TLS_CERT / TLS_KEY | – | PEM files: serve HTTPS directly |
| HTTP_REDIRECT_PORT | – | with TLS: plain-HTTP port that redirects to HTTPS |

## HTTPS

Either put a reverse proxy in front (e.g. Caddy: `your.domain { reverse_proxy 127.0.0.1:8080 }`)
and run with `HOST=127.0.0.1 TRUST_PROXY=1`, or pass `TLS_CERT`/`TLS_KEY`.
Don't expose plain HTTP to the internet.

## Security

- 5 wrong logins locks that IP for 15 minutes.
- Session cookie: HttpOnly, SameSite=Strict, Secure over HTTPS; HSTS over HTTPS.
- Sessions are in memory; restarting logs everyone out.

## Notes

- The camera must send H.264 (`-c:v copy`). For H.265, use `-c:v libx264 -preset ultrafast` (CPU heavy).
- Latency is roughly 2-3x the camera's keyframe interval.
- Tap ⛶ (or double-click) for fullscreen.
