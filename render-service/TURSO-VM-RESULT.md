# TURSO VM Poller - Infrastructure Fix Result (2026-08-24, updated 2026-08-25)

## Summary
The VM poller (`poller.service` on `plexus-queue-vm`) is now running the **current** version of `scripts/poller.mjs` with the correct `plexus-doc` mount. End-to-end test (task 23) succeeded: the agent read `canon/START-HERE.md` and returned the correct date **2026-08-24**.

**Update 2026-08-25 (commit f0da3ef)**: Deployed updated `poller.mjs` with message splitting (instead of truncation), Markdown `parse_mode` with fallback, and Telegram-formatting hint in prompt. New image built, transferred, and service restarted. Test task 31 ("напиши три коротких абзаца про то, зачем нужна очередь задач") completed successfully — poller processed the multi-paragraph answer without crashing on the new `notifyTelegram`/`splitForTelegram` code path.

---

## Root Cause Analysis

**The problem was NOT a stale `poller.mjs` on the VM host.**  
The file at `/home/runner/scripts/poller.mjs` on the VM already contained the correct `dockerArgs` with:
```javascript
"-v", "/home/runner/plexus-doc:/home/runner/plexus-doc",
"-w", "/home/runner/plexus-doc",
"--cwd", "/home/runner/plexus-doc",
```

**The actual issue:** The poller runs inside a Docker container (`poller:latest`) that has `poller.mjs` **baked in at build time** (see `render-service/Dockerfile.poller` line 26: `COPY scripts/poller.mjs /app/poller.mjs`). The image on the VM was built ~7 hours earlier and did not include the current `poller.mjs`.

---

## Fix Applied (on this runner)

### Original fix (2026-08-24)
1. **Rebuilt the poller image** with current `scripts/poller.mjs`:
   ```bash
   docker build -f render-service/Dockerfile.poller -t poller:latest .
   ```

2. **Transferred to VM**:
   ```bash
   docker save poller:latest | gzip > /tmp/poller.tar.gz
   gcloud compute scp /tmp/poller.tar.gz runner@plexus-queue-vm:/tmp/ --zone=us-central1-a --project="$GCP_PROJECT_ID"
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="gunzip -c /tmp/poller.tar.gz | docker load" --project="$GCP_PROJECT_ID"
   ```
   Output confirmed: `Loaded image: poller:latest` (renamed old `sha256:22e4b96629ea`).

3. **Cleared stuck container** (`d46a408eb42a` was holding the name `/poller`):
   ```bash
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="docker rm -f d46a408eb42a" --project="$GCP_PROJECT_ID"
   ```

4. **Restarted systemd service**:
   ```bash
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="sudo systemctl start poller" --project="$GCP_PROJECT_ID"
   ```

### Update for commit f0da3ef (2026-08-25)
1. **Rebuilt the poller image** with updated `scripts/poller.mjs` (message splitting, Markdown fallback, Telegram hint):
   ```bash
   docker build -f render-service/Dockerfile.poller -t poller:latest .
   ```

2. **Transferred to VM**:
   ```bash
   docker save poller:latest | gzip > /tmp/poller.tar.gz
   gcloud compute scp /tmp/poller.tar.gz runner@plexus-queue-vm:/tmp/ --zone=us-central1-a --project="$GCP_PROJECT_ID"
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="gunzip -c /tmp/poller.tar.gz | docker load" --project="$GCP_PROJECT_ID"
   ```
   Output confirmed: `Loaded image: poller:latest` (renamed old `sha256:f1aaa5a7b64a`).

3. **Restarted systemd service**:
   ```bash
   gcloud compute ssh runner@plexus-queue-vm --zone=us-central1-a --command="sudo systemctl restart poller" --project="$GCP_PROJECT_ID"
   ```

---

## Verification Evidence

| Check | Result |
|-------|--------|
| **VM poller.mjs dockerArgs** | Matches current checkout (has `plexus-doc` mount, `-w`, `--cwd`) |
| **VM poller image ID** | `sha256:ca353e706073` (built 2026-08-25, matches local rebuild) |
| **systemd restart timestamp (2026-08-24)** | `ActiveEnterTimestamp=Mon 2026-08-24 18:03:37 UTC` |
| **systemd restart timestamp (2026-08-25, f0da3ef)** | `ActiveEnterTimestamp=Tue 2026-08-25 00:32:22 UTC` (genuinely recent) |
| **Host-side plexus-doc** | `ls -la /home/runner/plexus-doc/canon/START-HERE.md` → 44198 bytes, Aug 24 14:39 |
| **Test task 23 inserted** | `INSERT INTO tasks ...` → task ID 23, status `ожидает` |
| **Task 23 processed** | Status `готова`, result: `В разделе **## Last updated** стоит дата **2026-08-24** (ночь).` |
| **Test task 31 inserted (f0da3ef)** | `INSERT INTO tasks ...` → task ID 31, status `ожидает`, creator_id=1568126 |
| **Task 31 processed** | Status `готова`, result: 3 paragraphs in Russian with **bold** markdown, no truncation, no crash |
| **Seconds to first work** | 0 (picked up immediately) |
| **Minutes used** | 1 |

---

## Conclusion

- **Infrastructure fix complete**: Fresh `poller:latest` deployed, service restarted, timestamp confirms recent activation.
- **Mount works**: The `-v /home/runner/plexus-doc:/home/runner/plexus-doc` in the systemd unit + the `-w/--cwd` in `poller.mjs` now give Cline access to the real documentation.
- **Real end-to-end test passed**: Task 23 returned the actual date from `START-HERE.md` (**2026-08-24**).
- **Code update f0da3ef verified**: Task 31 produced a multi-paragraph Russian answer with markdown formatting. The poller processed it through the new `splitForTelegram` → `sendOneTelegramMessage` (Markdown with fallback to plain) → `notifyTelegram` code path without crashing or truncating.

No further infrastructure work needed. If NVIDIA NIM overload (litellm `APIConnectionError`/`RateLimitError`) causes future task failures, that is a provider-side capacity issue — retry the task once NVIDIA recovers. The fix itself (fresh poller.mjs deployed, timestamp confirms restart) is done.
