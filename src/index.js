/**
 * LRC Sync Worker — Cloudflare Worker + Durable Object
 * ------------------------------------------------------
 * Backend WebSocket pengganti untuk "LOADING RATE CONTROL" front-end
 * (index.html). Mengimplementasikan protokol yang sama persis dengan yang
 * dipanggil dari client:
 *
 *   Client -> Server:
 *     register_session { userCode, userLabel, sessionId }
 *     pull_data         { userCode, force }
 *     sync_update       { payload, sessionId, userCode }
 *     acquire_lock      { lockKey, userCode, userLabel }
 *     release_lock      { lockKey, userCode }
 *
 *   Server -> Client:
 *     init / sync        { payload, activeSessions, force }
 *     sync_locks         { locks }
 *     lock_acquired       { lockKey, userCode, userLabel }
 *     lock_released       { lockKey, userCode }
 *     lock_failed         { lockKey, heldBy, heldByLabel }
 *     force_kick          {}   (dikirim ke sesi LAMA saat user login di device lain)
 *
 * MULTI-DATABASE / MULTI-TENANT:
 *   Satu Worker + Durable Object namespace ini bisa melayani BANYAK database
 *   independen sekaligus. Setiap koneksi WebSocket membawa query param
 *   `room` (mis. ?room=klien-a). Room yang berbeda = Durable Object instance
 *   yang berbeda = data yang 100% terpisah (tidak saling lihat).
 *   Front-end mengisi `room` ini dari konstanta APP_ID di index.html — jadi
 *   untuk bikin "instalasi baru" untuk klien/departemen lain, cukup deploy
 *   copy index.html dengan APP_ID yang beda, TANPA perlu deploy Worker baru.
 */

const LOCK_TTL_MS = 45000; // auto-expire lock kalau tidak ada refresh/release (client refresh tiap 30s)

export class SyncRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map(); // ws -> { userCode, sessionId, userLabel }
    this.data = null; // { ...seluruh state app, lastUpdated, updatedBy }
    this.locks = {}; // lockKey -> { userCode, userLabel, timestamp }
    this.activeSessions = {}; // userCode -> sessionId (device yg sedang login)
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    const [data, locks, activeSessions] = await Promise.all([
      this.state.storage.get("data"),
      this.state.storage.get("locks"),
      this.state.storage.get("activeSessions"),
    ]);
    this.data = data || { lastUpdated: 0 };
    this.locks = locks || {};
    this.activeSessions = activeSessions || {};
    this.loaded = true;
  }

  purgeStaleLocks() {
    const now = Date.now();
    let changed = false;
    for (const key of Object.keys(this.locks)) {
      if (now - (this.locks[key].timestamp || 0) > LOCK_TTL_MS) {
        delete this.locks[key];
        changed = true;
      }
    }
    return changed;
  }

  sendTo(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      // socket sudah mati, biar dibersihkan oleh event "close"
    }
  }

  broadcast(obj, exceptWs = null) {
    const msg = JSON.stringify(obj);
    for (const ws of this.sockets.keys()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(msg);
      } catch (e) {
        this.sockets.delete(ws);
      }
    }
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const userCode = url.searchParams.get("userCode") || "guest";
    const sessionId = url.searchParams.get("sessionId") || "";
    this.sockets.set(server, { userCode, sessionId, userLabel: userCode });

    server.addEventListener("message", (evt) => {
      this.handleMessage(server, evt).catch(() => {});
    });
    const cleanup = () => this.sockets.delete(server);
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    // Kirim state awal begitu konek (sesuai ekspektasi client: sync/init + sync_locks)
    this.purgeStaleLocks();
    this.sendTo(server, {
      type: "init",
      payload: this.data,
      activeSessions: this.activeSessions,
    });
    this.sendTo(server, { type: "sync_locks", locks: this.locks });

    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(ws, evt) {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case "register_session": {
        const { userCode, sessionId, userLabel } = msg;
        this.sockets.set(ws, { userCode, sessionId, userLabel });

        if (userCode && userCode !== "guest") {
          const prevSessionId = this.activeSessions[userCode];
          if (prevSessionId && prevSessionId !== sessionId) {
            // Ada device lain yang masih login dengan userCode yang sama ->
            // tendang sesi lama (single-session-per-user, sama seperti
            // implementasi lama).
            for (const [otherWs, meta] of this.sockets.entries()) {
              if (
                otherWs !== ws &&
                meta.userCode === userCode &&
                meta.sessionId === prevSessionId
              ) {
                this.sendTo(otherWs, { type: "force_kick" });
              }
            }
          }
          this.activeSessions[userCode] = sessionId;
          await this.state.storage.put("activeSessions", this.activeSessions);
        }
        break;
      }

      case "pull_data": {
        this.purgeStaleLocks();
        this.sendTo(ws, {
          type: "sync",
          payload: this.data,
          activeSessions: this.activeSessions,
          force: !!msg.force,
        });
        this.sendTo(ws, { type: "sync_locks", locks: this.locks });
        break;
      }

      case "sync_update": {
        if (msg.payload) {
          this.data = msg.payload;
          await this.state.storage.put("data", this.data);
          // Broadcast ke SEMUA client (termasuk pengirim, agar konsisten) —
          // client yang sedang aktif edit akan menahan apply-nya sendiri
          // (lihat logic isEditing/pendingPushRef di front-end).
          this.broadcast({
            type: "sync",
            payload: this.data,
            activeSessions: this.activeSessions,
            force: true,
          });
        }
        break;
      }

      case "acquire_lock": {
        this.purgeStaleLocks();
        const { lockKey, userCode, userLabel } = msg;
        const existing = this.locks[lockKey];
        if (existing && existing.userCode !== userCode) {
          this.sendTo(ws, {
            type: "lock_failed",
            lockKey,
            heldBy: existing.userCode,
            heldByLabel: existing.userLabel,
          });
        } else {
          this.locks[lockKey] = { userCode, userLabel, timestamp: Date.now() };
          await this.state.storage.put("locks", this.locks);
          this.broadcast({ type: "lock_acquired", lockKey, userCode, userLabel });
        }
        break;
      }

      case "release_lock": {
        const { lockKey, userCode } = msg;
        if (this.locks[lockKey]) {
          delete this.locks[lockKey];
          await this.state.storage.put("locks", this.locks);
        }
        this.broadcast({ type: "lock_released", lockKey, userCode });
        break;
      }

      default:
        break;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/ws") {
      return new Response(
        "LRC Sync Worker aktif. Hubungkan lewat wss://<worker-domain>/ws?room=<APP_ID>&userCode=...&sessionId=...",
        { status: 200 },
      );
    }

    // `room` = nama database/instalasi (diisi dari APP_ID di index.html).
    // Room berbeda -> Durable Object instance berbeda -> data terpisah total.
    const room = url.searchParams.get("room") || "default";
    const id = env.SYNC_ROOM.idFromName(room);
    const stub = env.SYNC_ROOM.get(id);
    return stub.fetch(request);
  },
};
