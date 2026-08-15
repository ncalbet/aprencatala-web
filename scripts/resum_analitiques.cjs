'use strict';
// Resum setmanal de visites de la landing: consulta Cloudflare Web Analytics
// (API GraphQL) i l'envia per correu. Només lectura; no toca res del lloc.
//
// Variables d'entorn (totes venen de secrets del repo):
//   CF_API_TOKEN   token de Cloudflare amb permís Account Analytics: Read
//   CF_ACCOUNT_ID  identificador del compte (accountTag)
//   CF_SITE_TAG    identificador del lloc dins de Web Analytics (siteTag)
//   SMTP_USER      compte de Gmail que envia
//   SMTP_PASS      contrasenya d'aplicació d'aquell compte (no la del compte!)
//   MAIL_TO        destinatari

const nodemailer = require('nodemailer');

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
const DIES = 7;

// ── Dates ────────────────────────────────────────────────────────────────────
// Finestra MÒBIL de 7 dies, no «setmana natural»: si un dia GitHub es menja el
// cron i el resum surt amb retard, segueix cobrint 7 dies exactes i no menteix.
function diaISO(desplacament) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + desplacament);
  return d.toISOString().slice(0, 10);
}

const AVUI = diaISO(0);
const INICI = diaISO(-DIES);           // període que es reporta: [INICI, AVUI)
const INICI_PREVI = diaISO(-DIES * 2); // període anterior, per comparar

// ── Consulta ─────────────────────────────────────────────────────────────────
async function graphql(query, variables) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });

  const cos = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(cos).slice(0, 400)}`);
  // Cloudflare retorna 200 amb errors dins del cos: sense això, un camp mal
  // escrit passaria per «zero visites» en comptes de per error.
  if (cos.errors && cos.errors.length) {
    throw new Error(`GraphQL: ${cos.errors.map(e => e.message).join(' | ').slice(0, 400)}`);
  }
  return cos.data;
}

const CAMPS_TOTALS = `
  sum { visits }
  count`;

// Totals del període: una fila agregada.
async function totals(desDe, finsA) {
  const q = `
    query($tag:String!, $site:String!, $desDe:Date!, $finsA:Date!) {
      viewer {
        accounts(filter: {accountTag: $tag}) {
          rumPageloadEventsAdaptiveGroups(
            limit: 1
            filter: {siteTag: $site, date_geq: $desDe, date_lt: $finsA}
          ) { ${CAMPS_TOTALS} }
        }
      }
    }`;
  const d = await graphql(q, {
    tag: process.env.CF_ACCOUNT_ID, site: process.env.CF_SITE_TAG,
    desDe, finsA
  });
  const fila = d.viewer.accounts[0]?.rumPageloadEventsAdaptiveGroups[0];
  return { visites: fila?.sum?.visits ?? 0, pagines: fila?.count ?? 0 };
}

// Desglossament per una dimensió. Tolerant a propòsit: si un nom de camp no
// existeix, retorna null i el correu surt igualment amb la resta de blocs.
// Un resum incomplet informa; un correu que no arriba, no.
async function desglossat(dimensio, limit = 8) {
  const q = `
    query($tag:String!, $site:String!, $desDe:Date!, $finsA:Date!) {
      viewer {
        accounts(filter: {accountTag: $tag}) {
          rumPageloadEventsAdaptiveGroups(
            limit: ${limit}
            filter: {siteTag: $site, date_geq: $desDe, date_lt: $finsA}
            orderBy: [sum_visits_DESC]
          ) {
            sum { visits }
            dimensions { ${dimensio} }
          }
        }
      }
    }`;
  try {
    const d = await graphql(q, {
      tag: process.env.CF_ACCOUNT_ID, site: process.env.CF_SITE_TAG,
      desDe: INICI, finsA: AVUI
    });
    return d.viewer.accounts[0].rumPageloadEventsAdaptiveGroups
      .map(f => ({ clau: f.dimensions[dimensio], visites: f.sum.visits }))
      .filter(f => f.clau !== null && f.clau !== '');
  } catch (e) {
    console.warn(`[avís] el desglossament per «${dimensio}» ha fallat: ${e.message}`);
    return null;
  }
}

// ── Format ───────────────────────────────────────────────────────────────────
function variacio(ara, abans) {
  if (!abans) return ara ? '—' : '—';
  const pct = Math.round(((ara - abans) / abans) * 100);
  if (pct === 0) return 'igual';
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)} %`;
}

function taula(titol, files, etiqueta) {
  if (files === null) return `<h3>${titol}</h3><p><i>No s'ha pogut obtenir.</i></p>`;
  if (!files.length) return `<h3>${titol}</h3><p><i>Sense dades aquesta setmana.</i></p>`;
  const cos = files.map(f =>
    `<tr><td>${escapa(String(f.clau))}</td><td align="right">${f.visites}</td></tr>`).join('');
  return `<h3>${titol}</h3>
    <table cellpadding="6" style="border-collapse:collapse;font-size:14px">
      <tr><th align="left">${etiqueta}</th><th align="right">Visites</th></tr>${cos}
    </table>`;
}

function escapa(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Guarda anti-duplicat ─────────────────────────────────────────────────────
// El cron té diverses oportunitats el mateix dia perquè GitHub en descarta
// moltes (veure el comentari del workflow). Sense això, arribarien 2-3 correus
// iguals les setmanes que sí que corren totes. Es mira l'historial del propi
// workflow: si ja n'hi ha un de reeixit fa menys de 6 dies, aquest plega.
async function jaEnviatAquestaSetmana() {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_WORKFLOW_REF } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) return false; // execució local: no hi ha guarda

  const fitxer = (GITHUB_WORKFLOW_REF || '').split('/').pop().split('@')[0];
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/${fitxer}/runs`
            + `?status=success&per_page=20`;
  try {
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!r.ok) return false;
    const { workflow_runs = [] } = await r.json();
    const límit = Date.now() - 6 * 24 * 3600 * 1000;
    return workflow_runs.some(run =>
      String(run.id) !== String(GITHUB_RUN_ID) && new Date(run.created_at).getTime() > límit);
  } catch {
    return false; // si la comprovació falla, val més un correu de més que cap
  }
}

// ── Principal ────────────────────────────────────────────────────────────────
async function run() {
  for (const v of ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_SITE_TAG', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO']) {
    if (!process.env[v]) throw new Error(`Falta la variable d'entorn ${v}`);
  }

  if (await jaEnviatAquestaSetmana()) {
    console.log('Ja s\'ha enviat un resum fa menys de 6 dies. No se n\'envia cap altre.');
    return;
  }

  const ara = await totals(INICI, AVUI);
  const abans = await totals(INICI_PREVI, INICI);
  console.log(`Període ${INICI} → ${AVUI}: ${ara.visites} visites, ${ara.pagines} pàgines vistes.`);

  const [pagines, referents, paisos, dispositius] = await Promise.all([
    desglossat('requestPath'), desglossat('refererHost'),
    desglossat('countryName', 6), desglossat('deviceType', 4)
  ]);

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px">
      <h2 style="margin-bottom:4px">AprènCatalà — visites de la web</h2>
      <p style="color:#666;margin-top:0">${INICI} → ${AVUI} (7 dies)</p>
      <table cellpadding="8" style="border-collapse:collapse;font-size:15px;margin-bottom:8px">
        <tr>
          <td><b>Visites</b></td><td align="right"><b>${ara.visites}</b></td>
          <td style="color:#666">${variacio(ara.visites, abans.visites)}</td>
        </tr>
        <tr>
          <td><b>Pàgines vistes</b></td><td align="right"><b>${ara.pagines}</b></td>
          <td style="color:#666">${variacio(ara.pagines, abans.pagines)}</td>
        </tr>
      </table>
      <p style="color:#666;font-size:13px">
        Comparat amb els 7 dies anteriors (${INICI_PREVI} → ${INICI}):
        ${abans.visites} visites i ${abans.pagines} pàgines vistes.
      </p>
      ${taula('Pàgines més visitades', pagines, 'Ruta')}
      ${taula('D\'on arriba la gent', referents, 'Origen')}
      ${taula('Països', paisos, 'País')}
      ${taula('Dispositius', dispositius, 'Tipus')}
      <p style="color:#888;font-size:12px;margin-top:20px">
        Font: Cloudflare Web Analytics. Les xifres són una cota inferior: els
        bloquejadors de publicitat filtren el comptador. No inclou l'app, que no
        en porta cap.
      </p>
    </div>`;

  const transport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });

  await transport.sendMail({
    from: `AprènCatalà <${process.env.SMTP_USER}>`,
    to: process.env.MAIL_TO,
    subject: `Visites de la web: ${ara.visites} aquesta setmana (${variacio(ara.visites, abans.visites)})`,
    html,
    text: `Visites: ${ara.visites} (abans ${abans.visites})\n`
        + `Pàgines vistes: ${ara.pagines} (abans ${abans.pagines})\n`
        + `Període ${INICI} → ${AVUI}`
  });

  console.log(`Correu enviat a ${process.env.MAIL_TO}.`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
