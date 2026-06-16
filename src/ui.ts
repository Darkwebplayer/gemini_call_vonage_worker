// Minimal single-page admin UI served at "/". Vanilla JS, no build step.
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Giggle Call Worker</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { border: 1px solid #ddd; padding: 6px 8px; text-align: left; font-size: 14px; }
  th { background: #f6f6f6; }
  form { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin-top: 1rem; }
  input { padding: 6px; border: 1px solid #ccc; border-radius: 4px; }
  button { padding: 6px 10px; border: 0; border-radius: 4px; cursor: pointer; background: #6b3fd6; color: #fff; }
  button.sec { background: #eee; color: #333; }
  .row-actions button { padding: 3px 7px; font-size: 12px; margin-right: 4px; }
  .muted { color: #888; }
  #msg { margin-top: 8px; min-height: 1.2em; }
</style>
</head>
<body>
<h1>Giggle — Shift Check-in</h1>

<table id="tbl">
  <thead><tr>
    <th>Name</th><th>Phone</th><th>Shift</th><th>Location</th><th>Status</th><th>Contacted</th><th></th>
  </tr></thead>
  <tbody></tbody>
</table>

<form id="form">
  <input type="hidden" id="id" />
  <input id="name" placeholder="Name" required />
  <input id="phone" placeholder="Phone (E.164, no +)" required />
  <input id="shiftStart" placeholder="Shift start (e.g. 6:00 PM)" />
  <input id="shiftEnd" placeholder="Shift end (e.g. 2:00 AM)" />
  <input id="location" placeholder="Location" />
  <div>
    <button type="submit">Save</button>
    <button type="button" class="sec" id="clearBtn">Clear</button>
  </div>
</form>
<div id="msg"></div>

<h2 style="font-size:1.2rem;margin-top:2rem;">Availability check (by call)</h2>
<p class="muted">Pick the worker and the days to verify, then place a call — the assistant asks about those days and records the answer.</p>
<form id="availForm" style="display:block;">
  <select id="availWorker" required style="margin-bottom:8px;"></select>
  <label style="display:block;margin-bottom:8px;"><input type="checkbox" id="wholeWeek" /> Whole week</label>
  <div id="days" style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:8px;"></div>
  <button type="submit">Call to check availability</button>
</form>
<div id="availMsg" class="muted" style="margin-top:6px;"></div>
<div id="availHistory" style="margin-top:6px;"></div>

<script>
const $ = (id) => document.getElementById(id);
const msg = (t) => ($("msg").textContent = t);

async function load() {
  const rows = await (await fetch("/api/workers", { cache: "no-store" })).json();
  $("tbl").querySelector("tbody").innerHTML = rows.map((w) => \`
    <tr>
      <td>\${w.name}</td><td>\${w.phone}</td>
      <td>\${w.shiftStart || ""}\${w.shiftEnd ? " – " + w.shiftEnd : ""}</td>
      <td>\${w.location || ""}</td>
      <td>\${w.shiftStatus || ""}</td>
      <td class="muted">\${w.contactedAt ? new Date(w.contactedAt).toLocaleString() : "—"}</td>
      <td class="row-actions">
        \${w.contactedAt
          ? \`<button onclick='call("\${w.id}","shift",true)'>Call again</button>\`
          : \`<button onclick='call("\${w.id}","shift",false)'>Call: Shift</button>\`}
        <button class="sec" onclick='edit(\${JSON.stringify(w).replace(/'/g, "&#39;")})'>Edit</button>
        <button class="sec" onclick='del("\${w.id}")'>Delete</button>
      </td>
    </tr>\`).join("");
  fillWorkerSelect(rows);
}

function clearForm() { $("form").reset(); $("id").value = ""; }

function edit(w) {
  $("id").value = w.id; $("name").value = w.name; $("phone").value = w.phone;
  $("shiftStart").value = w.shiftStart || ""; $("shiftEnd").value = w.shiftEnd || "";
  $("location").value = w.location || ""; msg("Editing " + w.name);
}

$("clearBtn").onclick = () => { clearForm(); msg(""); };

$("form").onsubmit = async (e) => {
  e.preventDefault();
  const id = $("id").value;
  const body = JSON.stringify({
    name: $("name").value, phone: $("phone").value,
    shiftStart: $("shiftStart").value, shiftEnd: $("shiftEnd").value, location: $("location").value,
  });
  try {
    const res = await fetch(id ? "/api/workers/" + id : "/api/workers", {
      method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body });
    if (!res.ok) { msg("Error: " + res.status); return; }
    clearForm();
    msg(id ? "Updated" : "Added");
    await load();
  } catch (err) { msg("Error: " + err); }
};

async function call(id, type, force) {
  if (!confirm((force ? "Call again" : "Place a " + type + " call") + "?")) return;
  const res = await fetch("/call/" + id + "?type=" + type + (force ? "&force=true" : ""), { method: "POST" });
  const j = await res.json();
  msg(res.ok ? type + " call placed… " + j.uuid : (j.reason || "Call failed") + " (" + res.status + ")");
  load();
}

async function del(id) {
  if (!confirm("Delete this worker?")) return;
  await fetch("/api/workers/" + id, { method: "DELETE" });
  msg("Deleted"); load();
}

// --- availability ---
const DAYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];

function renderDays() {
  $("days").innerHTML = DAYS.map((d) =>
    \`<label style="text-transform:capitalize"><input type="checkbox" class="day" value="\${d}" /> \${d}</label>\`).join("");
}

$("wholeWeek").onchange = (e) =>
  document.querySelectorAll(".day").forEach((c) => { c.checked = false; c.disabled = e.target.checked; });

function fillWorkerSelect(rows) {
  const cur = $("availWorker").value;
  $("availWorker").innerHTML = rows.map((w) => \`<option value="\${w.id}">\${w.name} (\${w.phone})</option>\`).join("");
  if (rows.some((w) => w.id === cur)) $("availWorker").value = cur;
  if ($("availWorker").value) loadAvail($("availWorker").value);
}

$("availWorker").onchange = (e) => loadAvail(e.target.value);

$("availForm").onsubmit = async (e) => {
  e.preventDefault();
  const userId = $("availWorker").value;
  const whole = $("wholeWeek").checked;
  const days = whole ? [] : DAYS.filter((d) => document.querySelector('.day[value="' + d + '"]').checked);
  if (!whole && !days.length) { $("availMsg").textContent = "Pick at least one day, or tick Whole week."; return; }
  if (!confirm("Call to check availability for: " + (whole ? "the whole week" : days.join(", ")) + "?")) return;
  const q = whole ? "&days=week" : "&days=" + encodeURIComponent(days.join(","));
  const res = await fetch("/call/" + userId + "?type=availability" + q, { method: "POST" });
  const j = await res.json();
  $("availMsg").textContent = res.ok ? "Availability call placed… " + j.uuid : (j.reason || "Call failed") + " (" + res.status + ")";
};

async function loadAvail(userId) {
  if (!userId) return;
  const hist = await (await fetch("/api/availability/" + userId, { cache: "no-store" })).json();
  $("availHistory").innerHTML = hist.length
    ? "<p class='muted'>Recorded:</p><ul>" +
      hist.map((h) => \`<li>\${new Date(h.createdAt).toLocaleString()}: asked [\${h.checked.join(", ") || "open"}] → available [\${h.available.join(", ") || "none"}]</li>\`).join("") +
      "</ul>"
    : "<p class='muted'>No availability checks yet.</p>";
}

renderDays();
load();
</script>
</body>
</html>`;
