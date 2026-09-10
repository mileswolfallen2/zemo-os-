# Zima Server Display

A zero-dependency, fullscreen dashboard for the HDMI display attached to a ZimaOS machine. It reads stats directly from the ZimaOS host: CPU use and temperature, RAM, uptime, disk usage, live network throughput, and Docker container status.

## Quick start

1. Copy this `zima-server-display` folder to your ZimaOS machine (for example, `/DATA/AppData/zima-server-display`). Install Node.js 18+ if it is not already available.
2. In that folder, edit `config.json`. Set the names of your running Docker containers under `services`, and optionally enable Minecraft.
3. Start it with:

   ```sh
   node server.js
   ```

4. On the ZimaOS HDMI screen, open Chromium or another browser to `http://localhost:8787`, then press **F11** for fullscreen. The dashboard updates every three seconds.

There are no packages to install; `npm start` is just a convenient alternative to `node server.js`.

## Configuration

- `storagePath`: disk or mount to show. Use `/` for the system disk, or a path such as `/DATA` for a ZimaOS data disk.
- `networkInterface`: leave `auto`, or set a device name such as `eth0` / `enp2s0` if the wrong adapter is shown.
- `services[].container`: the exact or partial Docker container name. Leave it blank for the Docker engine indicator.
- `minecraft.enabled`: set `true` to use Minecraft's standard Server List Ping protocol. It reports the current and maximum player count when the server permits status pings.

## Keep it running after reboot (systemd)

Create `/etc/systemd/system/zima-display.service` with the following, updating `WorkingDirectory` to where you copied the project:

```ini
[Unit]
Description=Zima HDMI Server Display
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/DATA/AppData/zima-server-display
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl daemon-reload`, `sudo systemctl enable --now zima-display`, and check it with `systemctl status zima-display`.

## Notes

- CPU temperature appears when ZimaOS exposes Linux thermal files or `sensors`; otherwise the dashboard displays `—`.
- Docker status needs the `docker` command available to the account running the server. If that account cannot access Docker, service cards will show unavailable.
- The API is local-only in spirit but listens on the LAN for convenience. Do not expose port 8787 to the internet.
