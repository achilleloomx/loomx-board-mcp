# Deploy — LoomX Chat (MCP remoto per claude.ai)

> MVP GTD `[MVP] LoomX Chat`. Owner build: **board-mcp**. Owner hosting: **forge** (VPS `loomx-hq`).
> Design: `hub/notes/2026-06-24-loomx-chat-mcp-design.md` (approccio C hybrid).

## Cosa è
Un secondo entrypoint dello stesso pacchetto `loomx-board-mcp`, avviato con `--remote`.
Espone via **Streamable HTTP** (transport remoto MCP) 5 tool human-first per Achille:
`fleet_status`, `decisions_inbox`, `ask_loomy`, `loomy_replies`, `quick_gtd`.
A differenza delle istanze per-agente (stdio), questa parla HTTP/SSE così claude.ai
(web + telefono) può aggiungerla come **custom connector**.

## Avvio
```bash
node dist/index.js --remote
```
Niente `--agent`: la modalità remota gira sotto l'identità `board-mcp` (code 005) e
scrive i messaggi del bridge taggandoli `from-achille` / `for-loomy`.

## Variabili d'ambiente
| Var | Obbligatoria | Default | Note |
|---|---|---|---|
| `SUPABASE_URL` | sì | — | stesso DB LoomX Home |
| `SUPABASE_SERVICE_ROLE_KEY` | sì | — | mai esposta al client; resta nell'env del servizio |
| `LOOMX_CHAT_TOKEN` | sì* | — | bearer token forte che Achille incolla in claude.ai |
| `LOOMX_CHAT_ALLOW_NOAUTH` | no | — | `=1` salta l'auth (solo test tailscale-only locale) |
| `LOOMX_CHAT_PORT` | no | `8787` | porta di ascolto |
| `LOOMX_CHAT_HOST` | no | `127.0.0.1` | bind; dietro Caddy lascia loopback |

\* Se manca `LOOMX_CHAT_TOKEN` e non c'è `LOOMX_CHAT_ALLOW_NOAUTH=1`, il server **rifiuta di partire** (fail-safe).

### Generare il token
```bash
openssl rand -base64 32
```

## Auth
Il server accetta il token in tre forme (in ordine):
1. `Authorization: Bearer <token>` (preferito)
2. header `x-loomx-token: <token>`
3. query `?token=<token>` (fallback per client che non settano header)

Confronto constant-time. Risposta `401` + `WWW-Authenticate: Bearer` se assente/errato.
Endpoint `/health` (GET) è senza auth, per probe systemd/Caddy.

## Posture di rete (parcheggiata — decide Achille)
- **Default raccomandato: Tailscale-only.** Bind `127.0.0.1`, Caddy ascolta sull'IP tailnet.
  Achille raggiunge il server solo da dispositivi nella tailnet. Il token è difesa in profondità.
- **Opzione public+token:** Caddy con dominio pubblico + TLS, token forte + rate-limit.
  Necessaria se Achille deve usarlo da telefono fuori dalla tailnet.

## systemd unit (template per forge)
`/etc/systemd/system/loomx-chat.service`:
```ini
[Unit]
Description=LoomX Chat — remote MCP for claude.ai
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/loomx/loomx-board-mcp
ExecStart=/usr/bin/node dist/index.js --remote
Restart=on-failure
RestartSec=3
Environment=LOOMX_CHAT_PORT=8787
Environment=LOOMX_CHAT_HOST=127.0.0.1
# Segreti via drop-in non versionato (systemctl edit) o EnvironmentFile:
EnvironmentFile=/etc/loomx/loomx-chat.env
# loomx-chat.env contiene: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LOOMX_CHAT_TOKEN
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/loomx/loomx-board-mcp

[Install]
WantedBy=multi-user.target
```

## Caddy reverse-proxy (template per forge)
Streamable HTTP usa SSE → **disabilita il buffering** e niente timeout aggressivi.

Tailscale-only:
```caddy
loomx-hq.<tailnet>.ts.net {
    handle_path /loomx-chat/* {
        reverse_proxy 127.0.0.1:8787 {
            flush_interval -1   # streaming SSE, no buffer
        }
    }
}
```
Public+token (se scelto):
```caddy
chat.loomx.it {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
    # opzionale: rate_limit (plugin) sul path /mcp
}
```
URL MCP finale = `https://<host>/loomx-chat/mcp` (o `/mcp` se non usi handle_path).

## Come Achille lo aggiunge a claude.ai
1. claude.ai → Settings → **Connectors** → *Add custom connector*.
2. **URL**: l'endpoint `…/mcp` (es. `https://loomx-hq.<tailnet>.ts.net/loomx-chat/mcp`).
3. **Auth**: incollare il bearer token (`LOOMX_CHAT_TOKEN`).
   - Nota parcheggiata: claude.ai privilegia OAuth per i connector remoti; se la UI non
     accetta un bearer statico, il fallback è passare il token in query (`…/mcp?token=…`)
     dietro Tailscale, oppure forge aggiunge un wrapper OAuth minimale. Da verificare con
     Achille al primo collegamento (vedi D-…-chat nelle DECISIONS).
4. Salvare → i 5 tool compaiono come strumenti utilizzabili in chat.

## Verifica rapida
```bash
curl -s https://<host>/loomx-chat/health           # {"ok":true,...}
# handshake MCP: 401 senza token, 200 con Bearer corretto
```

## Il bridge ask_loomy → loomy_replies (convenzione)
- `ask_loomy(text)` → INSERT `board_messages` from=005(board-mcp) to=001(loomy),
  type=question, tags `loomx-chat,from-achille,for-loomy`. Il body contiene l'istruzione
  per Loomy: *rispondi con `board_send to_agent=board-mcp, ref_id=<id>, tag 'for-achille'`*.
- `loomy_replies` → SELECT messaggi loomy→board-mcp che hanno `ref_id` su una domanda di
  Achille **oppure** tag `for-achille`. Latenza = cadenza del loop di Loomy (minuti);
  con Loomy Assistant 24/7 diventerà ~realtime.
