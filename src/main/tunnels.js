'use strict';

// Local port forwarding (an SSH tunnel per port): a web panel or API that the
// server only serves on its own localhost opens in this computer's browser at
// http://127.0.0.1:<port>. Each tunnel listens locally and opens a
// direct-tcpip channel over the existing SSH link for every connection, so a
// reconnect is picked up by the next request without restarting anything.

const EventEmitter = require('events');
const net = require('net');

const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65536;
const validHost = (h) => typeof h === 'string' && /^[\w.:-]{1,253}$/.test(h);

class Tunnels extends EventEmitter {
  constructor(conn) {
    super();
    this.conn = conn;
    this.list = new Map(); // id → tunnel
  }

  publicList() {
    return [...this.list.values()].map((t) => ({
      id: t.id,
      remoteHost: t.remoteHost,
      remotePort: t.remotePort,
      localPort: t.localPort,
      wanted: t.wanted,
      active: t.active,
      total: t.total,
      error: t.error,
    }));
  }

  changed() {
    this.emit('update', this.publicList());
  }

  /** Start forwarding 127.0.0.1:localPort → remoteHost:remotePort (as seen from the server). */
  async add({ remoteHost = '127.0.0.1', remotePort, localPort = null }) {
    remotePort = Number(remotePort);
    localPort = localPort == null || localPort === '' ? remotePort : Number(localPort);
    if (!validPort(remotePort)) throw new Error('Server porti 1–65535 oralig‘ida bo‘lsin');
    if (!validPort(localPort)) throw new Error('Kompyuterdagi port 1–65535 oralig‘ida bo‘lsin');
    if (!validHost(remoteHost)) throw new Error('Manzil noto‘g‘ri');
    const id = `${remoteHost}:${remotePort}`;
    if (this.list.has(id)) return this.publicList();

    const t = { id, remoteHost, remotePort, wanted: localPort, localPort: null, active: 0, total: 0, error: null, server: null, sockets: new Set() };
    const server = net.createServer((sock) => this.pipe(t, sock));
    server.on('error', (err) => {
      t.error = err.message;
      this.changed();
    });
    const listen = (port) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
    try {
      await listen(localPort);
    } catch (err) {
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
      // Busy (or privileged) here: take any free port and say so in the list.
      await listen(0);
      t.error = `${localPort}-port band edi — ${server.address().port} ishlatildi`;
    }
    t.server = server;
    t.localPort = server.address().port;
    this.list.set(id, t);
    this.changed();
    return this.publicList();
  }

  pipe(t, sock) {
    sock.on('error', () => {});
    const client = this.conn.client;
    if (!client || this.conn.state !== 'ready') {
      sock.destroy();
      return;
    }
    try {
      client.forwardOut('127.0.0.1', sock.remotePort || 0, t.remoteHost, t.remotePort, (err, stream) => {
        if (err) {
          // Channel open failure reasons (RFC 4254): 1 = forwarding is off on the server, 2 = nothing answers there.
          t.error =
            err.reason === 1 || /administratively/i.test(err.message)
              ? 'Serverda tunnel ochish taqiqlangan (sshd: AllowTcpForwarding)'
              : err.reason === 2 || /refused|connect failed/i.test(err.message)
                ? `Serverda ${t.remotePort}-portda hech narsa ishlamayapti`
                : err.message;
          sock.destroy();
          this.changed();
          return;
        }
        t.error = null;
        t.active += 1;
        t.total += 1;
        t.sockets.add(sock);
        this.changed();
        let ended = false;
        const done = () => {
          if (ended) return;
          ended = true;
          t.active = Math.max(0, t.active - 1);
          t.sockets.delete(sock);
          this.changed();
        };
        stream.on('error', () => {});
        stream.on('close', () => {
          sock.destroy();
          done();
        });
        sock.on('close', () => {
          stream.close?.();
          done();
        });
        sock.pipe(stream).pipe(sock);
      });
    } catch {
      sock.destroy();
    }
  }

  remove(id) {
    const t = this.list.get(id);
    if (!t) return this.publicList();
    this.list.delete(id);
    t.server?.close();
    for (const s of t.sockets) s.destroy();
    this.changed();
    return this.publicList();
  }

  closeAll() {
    for (const id of [...this.list.keys()]) this.remove(id);
  }

  /** TCP ports the server listens on (ss, else netstat), with the program when visible. */
  async scan() {
    const r = await this.conn.exec('ss -ltnpH 2>/dev/null || ss -ltnH 2>/dev/null || netstat -ltnp 2>/dev/null || netstat -ltn 2>/dev/null; true', 10000);
    const seen = new Map();
    for (const line of String(r.stdout || '').split('\n')) {
      const cols = line.trim().split(/\s+/);
      // ss: State Recv-Q Send-Q Local Peer [Process]; netstat: Proto Recv-Q Send-Q Local Foreign State [PID/Program]
      const local = /^(LISTEN|tcp6?)$/.test(cols[0]) ? cols[3] : null;
      if (!local) continue;
      const m = local.match(/^(.*):(\d+)$/);
      if (!m) continue;
      const port = Number(m[2]);
      const addr = m[1].replace(/^\[|\]$/g, '');
      const proc = (line.match(/users:\(\("([^"]+)"/) || line.match(/\d+\/(\S+)\s*$/) || [])[1] || null;
      const local127 = /^(127\.|::1$|localhost)/.test(addr);
      const prev = seen.get(port);
      if (!prev) seen.set(port, { port, addr, proc, localOnly: local127 });
      else {
        prev.localOnly = prev.localOnly && local127;
        prev.proc = prev.proc || proc;
      }
    }
    return [...seen.values()].filter((p) => p.port !== 22).sort((a, b) => a.port - b.port);
  }
}

module.exports = { Tunnels };
