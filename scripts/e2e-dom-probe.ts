/**
 * e2e DOM probe (#54) — the selector-archaeology pass for the BROWSER RIG, run by hand.
 *
 * When the pinned host moves and a spec starts failing on "composer did not take focus",
 * the question is what the page actually looks like NOW — and no assertion answers that.
 * This boots one e2e server, opens the app, walks the FIRST steps of the real spec path
 * (New session → is the composer attached?), and dumps the interactive surface:
 * activeElement, tree rows, anything labelled Preview, and the composer count.
 *
 *   E2E_PROBE_PORT=41799 node --experimental-strip-types scripts/e2e-dom-probe.ts
 *
 * Writes var/e2e-dom-probe.json and prints it. It STOPS the server it started: a probe
 * that leaks an orphan makes the next run die on the port guard talking about its own
 * predecessor (measured 2026-10-21, and the guard's message is what named the pid).
 */
import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { bootE2eServer, ROOT } from '../tests/e2e/boot.ts'
import { dismissTestingNotice, typeComposer, openSessionByRow, durableLogExists, E2E_SESS_DIR, sessionLogFileFor } from '../tests/e2e/session.ts'

const port = Number(process.env.E2E_PROBE_PORT ?? 41799)
const boot = await bootE2eServer(port, { thresholdRatio: '0.9' })
const browser = await chromium.launch({ executablePath: process.env.E2E_CHROMIUM ?? undefined })
const page = await browser.newPage()
// The client-side truth: if a slot registration throws, the host renders the message
// WITHOUT our row and the only trace is a browser console line. Capture it — pageerror
// for throws, console for the host's own warnings — and dump it with everything else.
const console_ = []
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console_.push(`${m.type()}: ${(m.text() ?? '').slice(0, 240)}`) })
page.on('pageerror', (e) => console_.push(`pageerror: ${String(e?.message ?? e).slice(0, 240)}`))
try {
  await page.goto(boot.url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  const dump = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('div'))
      .filter((d) => d.querySelector('button') && /notice|preview|welcome|terms|consent/i.test(d.textContent ?? ''))
      .slice(0, 6)
      .map((d) => ({ text: (d.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 260), buttons: Array.from(d.querySelectorAll('button')).map((b) => ((b.textContent ?? '').trim().slice(0, 40)) || (b.getAttribute('aria-label') ?? '?')) }))
    const aria = Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')!).filter((v, i, a) => a.indexOf(v) === i)
    return {
      url: location.href,
      active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
      dialogs,
      composerish: aria.filter((a) => /command|file|session|input|message|notice/i.test(a)).slice(0, 25),
      allCount: aria.length,
    }
  })
  // now walk the spec's actual path: click New session, then see what the draft looks like
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
      .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
    btn?.click()
  })
  await page.waitForTimeout(6000)
  const after = await page.evaluate(() => ({
    active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
    treeitems: Array.from(document.querySelectorAll('[role="treeitem"]')).map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)).slice(0, 10),
    previews: Array.from(document.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')!).filter((a) => /preview/i.test(a)).slice(0, 10),
    composerAttached: document.querySelectorAll('div[aria-label*="/ commands, @ files or sessions"]').length,
    current: (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null') as { sessionId?: string })?.sessionId ?? null,
  }))
  dump.after = after
  // the composer locator matches WHAT, and what actually sits under the point the rig
  // clicks — 'composer did not take focus (active: Preview Notice)' says only that the
  // click landed somewhere else
  dump.composers = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div[aria-label*="/ commands, @ files or sessions"]'))
    return els.map((e) => {
      const r = (e as HTMLElement).getBoundingClientRect()
      const probe = document.elementFromPoint(r.x + Math.min(60, r.width / 2), r.y + r.height / 2)
      return {
        label: e.getAttribute('aria-label'),
        tag: e.tagName,
        contenteditable: e.getAttribute('contenteditable'),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        visible: r.width > 0 && r.height > 0,
        underClickPoint: probe === null ? null : `${probe.tagName}:${probe.getAttribute('aria-label') ?? (probe.textContent ?? '').trim().slice(0, 30)}`,
      }
    })
  })
  dump.dialog = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')
    if (d === null) return null
    return {
      label: d.getAttribute('aria-label'),
      text: (d.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      buttons: Array.from(d.querySelectorAll('button')).map((b) => ({
        text: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
        aria: b.getAttribute('aria-label'), disabled: (b as HTMLButtonElement).disabled,
      })),
      inputs: Array.from(d.querySelectorAll('input, [role="checkbox"], [role="switch"]')).map((i) => ({
        tag: i.tagName, type: i.getAttribute('type'), role: i.getAttribute('role'),
        aria: i.getAttribute('aria-label'), checked: (i as HTMLInputElement).checked,
      })),
    }
  })
  dump.noticeEls = await page.evaluate(() => Array.from(document.querySelectorAll('[aria-label]'))
    .filter((e) => /notice/i.test(e.getAttribute('aria-label') ?? ''))
    .map((e) => ({ label: e.getAttribute('aria-label'), tag: e.tagName, role: e.getAttribute('role'),
      rect: (() => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}` })() })))
  if (process.env.DOOR_PROBE_TURN === '1') {
    // The thing we are actually chasing (#54): our door rows are in the DOM but NOT
    // visible on the 0.2.x client, so the fork affordance a user must click cannot be
    // clicked. That can only be seen with a REAL assistant row on screen, so drive one
    // turn (tool-free, one sentence) and then describe the action row geometry.
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button[aria-label="New session"]'))
        .find((b) => /New Session/i.test(b.textContent ?? '')) as HTMLButtonElement | undefined
      btn?.click()
    })
    await page.waitForTimeout(4000)
    // the notice is a focus trap; openApp clears it, and this path skips openApp
    await dismissTestingNotice(page)
    await typeComposer(page, 'Name one HTTP redirect status code in one short sentence. Make ZERO tool calls.')
    for (let i = 0; i < 40; i++) {
      const done = await page.evaluate(() => document.querySelectorAll('button').length > 0
        && /Cache hit|tok\/s/.test(document.body.textContent ?? ''))
      const busy = await page.evaluate(() => /Stop|Generating|thinking/i.test(document.body.textContent ?? ''))
      if (done && !busy) break
      await page.waitForTimeout(3000)
    }
    await page.waitForTimeout(3000)
    dump.slots = await page.evaluate(() => {
    // Our component's own className, and every slot-ish container the host renders, so
    // "not mounted" is distinguished from "mounted and hidden" by more than one signal.
    const mine = Array.from(document.querySelectorAll('[class*="dsh-chapters"]'))
      .map((e) => `${e.tagName}.${(e.className ?? '').toString().slice(0, 40)}[${e.getAttribute('aria-label') ?? ''}]`)
    const styles = Array.from(document.querySelectorAll('style')).map((s) => (s.textContent ?? '').slice(0, 24))
      .filter((t) => t.includes('dsh-chapters'))
    const detail = mine.map((label) => {
      const el = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? '') === label.slice(label.indexOf('[') + 1, label.lastIndexOf(']')))
      if (el === undefined) return { label, found: false }
      const b = el as HTMLElement
      const r = b.getBoundingClientRect()
      const cs = getComputedStyle(b)
      const chain = []
      let p = b.parentElement
      for (let i = 0; i < 6 && p !== null; i++) { chain.push(`${p.tagName}.${(p.className ?? '').toString().split(/\s+/).slice(0, 2).join('.')}`); p = p.parentElement }
      const anc = b.closest('[class*="essage"],[class*="ssistant"],[role="listitem"],article')
      return { label, found: true, rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity, inDocument: document.contains(b),
        messageAncestor: anc === null ? 'NONE — not inside a message subtree' : `${anc.tagName}.${(anc.className ?? '').toString().slice(0, 40)}`,
        parentChain: chain.join(' < ') }
    })
    return { mine, detail, ourCssInjected: styles.length > 0, actionRows: Array.from(document.querySelectorAll('[class*="actions"]')).length }
  })
  dump.console = console_.slice(-25)
  dump.doors = await page.evaluate(() => {
      const probe = (el: Element) => {
        const b = el as HTMLElement
        const r = b.getBoundingClientRect()
        const cs = getComputedStyle(b)
        const chain: string[] = []
        let p: HTMLElement | null = b.parentElement
        for (let i = 0; i < 5 && p !== null; i++) { chain.push(`${p.tagName}.${(p.className ?? '').toString().split(/\s+/).slice(0, 2).join('.')}`); p = p.parentElement }
        return {
          aria: b.getAttribute('aria-label'), text: (b.textContent ?? '').trim().slice(0, 30),
          rect: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
          overflowHidden: cs.overflow, parentChain: chain.join(' < '),
        }
      }
      const hit = (el: Element) => /chapters|fork|continue with|branch/i.test(el.getAttribute('aria-label') ?? '')
      const ours = Array.from(document.querySelectorAll('button')).filter(hit).map(probe)
      // the host's own assistant action row is the neighbour that DOES render (Copy)
      const copy = Array.from(document.querySelectorAll('button')).find((b) => (b.getAttribute('aria-label') ?? '') === 'Copy')
      const row = copy?.parentElement as HTMLElement | undefined
      const siblings = Array.from(row?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').trim().slice(0, 24))
      const menus = Array.from(document.querySelectorAll('button'))
        .filter((b) => /more|actions|overflow/i.test((b.getAttribute('aria-label') ?? '') + (b.textContent ?? '')))
        .map((b) => b.getAttribute('aria-label') ?? (b.textContent ?? '').trim().slice(0, 24))
      return { ours, rowTag: row?.tagName ?? null, rowClass: (row?.className ?? '').slice(0, 90), rowRect: row ? JSON.stringify(row.getBoundingClientRect()) : null, siblings, menus }
    })
    // and does the door, when force-clicked, leave anything observable behind?
    const clicked = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => (x.getAttribute('aria-label') ?? '') === 'Fork with chapters')
      if (!b) return 'absent'
      ;(b as HTMLButtonElement).click()
      return 'clicked'
    })
    await page.waitForTimeout(12000)
    // What did the door ANSWER? Our component renders its result into a note span
    // (.dsh-chapters_forkNote); an error text there is the difference between "the host
    // lost the child" and "the plugin refused to fork".
    dump.doorSaid = await page.evaluate(() => {
      const notes = Array.from(document.querySelectorAll('[class*="forkNote"], [class*="dsh-chapters"]'))
        .map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200))
        .filter((t) => t !== '')
      return { notes, bodyTail: (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(-300) }
    })
    // Does a RELOAD make the child visible? That is the question the journeys hinge on:
    // if the sidebar lists it after a refetch, the rig (and the door) can open it; if a
    // reload changes nothing, the session is invisible to the UI as well as to disk, and
    // the honest conclusion is that 0.2.x will not show a created-but-never-started child.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(6000)
    await dismissTestingNotice(page)
    dump.afterReload = await page.evaluate(() => ({
      rows: Array.from(document.querySelectorAll('[role="treeitem"]')).map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 42)),
    }))
    // The runner's OWN words. src/client/doors.ts returns a note ONLY when it could not
    // switch: '' means sessions.open(child) worked, 'branch created — appearing in the
    // sidebar' / '… open it in the sidebar' means the service path failed and the row-click
    // fallback fell through too. That distinguishes a client-service drift from a
    // switch-that-happened-but-didn't-stick without reading a minified bundle.
    dump.doorNote = await page.evaluate(() => {
      const n = document.querySelector('[class*="forkNote"]')
      const dlg = document.querySelector('[role="dialog"], [aria-label*="Notice"]')
      return {
        note: n === null ? '(no note element — the runner reported success)' : (n.textContent ?? '').trim().slice(0, 160),
        dialog: dlg === null ? null : (dlg.getAttribute('aria-label') ?? '?'),
        active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
        current: (JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null') as { sessionId?: string } | null)?.sessionId ?? null,
      }
    })
    const kids = (() => { try { return fs.readdirSync(E2E_SESS_DIR).filter((d) => d.startsWith('ch-')) } catch { return [] } })()
    dump.child = {
      clicked, dirs: kids.length,
      withLog: kids.filter((d) => sessionLogFileFor(`${E2E_SESS_DIR}/${d}`) !== null).length,
      rowOpenable: kids.length > 0 ? await openSessionByRow(page, [kids[kids.length - 1].replace(/^ch-/, '')]) : false,
      projcache: (() => { try { return fs.readdirSync(`${process.cwd()}/var/e2e-home-${process.env.E2E_PROBE_PORT ?? 41799}/storages/session_projcache/sessions`).length } catch { return -1 } })(),
    }
  }
  dump.dismiss = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"], [aria-label*="Notice"]')
    return d === null ? 'no dialog present at this moment' : `dialog: ${d.getAttribute('aria-label') ?? '?'} / buttons: ${Array.from(d.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim() || b.getAttribute('aria-label') || '?').join('|')}`
  })
  await dismissTestingNotice(page)
  await page.waitForTimeout(1200)
  dump.afterDismiss = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"], [aria-label*="Notice"]')
    return { dialog: d === null ? null : (d.getAttribute('aria-label') ?? '?'),
      active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? 'none',
      composerFocused: (() => { const ae = document.activeElement; return ae !== null && (ae.matches('div[aria-label*="/ commands, @ files or sessions"]') || ae.closest('div[aria-label*="/ commands, @ files or sessions"]') !== null) })() }
  })
  fs.writeFileSync(path.join(ROOT, 'var', 'e2e-dom-probe.json'), JSON.stringify(dump, null, 2))
  console.log(JSON.stringify(dump, null, 2).slice(0, 2600))
} finally {
  await browser.close()
  await boot.stop()
}
