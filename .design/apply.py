"""One-time, branch-scoped refactor; removed before merging the redesign."""
from pathlib import Path
import re
root = Path('.')
h = (root / 'index.html').read_text()
if '<style>' in h:
    h = re.sub(r'  <style>[\s\S]*?</style>', '  <link rel="stylesheet" href="/styles.css">', h, count=1)
    h = h.replace('content="#f4efe5"', 'content="#f7f5f0"')
    h = h.replace('  <title>Long Form</title>', '  <meta name="color-scheme" content="light">\n  <title>Long Form</title>')
    h = h.replace('<div class="topbar">', '<header class="topbar">', 1)
    h = h.replace('    <div class="top-actions">${actions}</div>\n  </div>\n  ${body}', '    <nav class="top-actions" aria-label="Account and navigation">${actions}</nav>\n  </header>\n  <a class="skip-link" href="#main-content">Skip to content</a>\n  <main id="main-content" tabindex="-1">${body}</main>', 1)
    h = h.replace('<main class="home-dashboard">', '<div class="home-dashboard">').replace('    </main>`,', '    </div>`,')
    h = h.replace('          <span class="micro-label">Library</span>\n', '')
    h = h.replace('              <span class="reading-kicker">Reading list</span>\n', '')
    old = '''        <button class="editor-open" id="open-editor" type="button">
          <span class="editor-copy">
            <span class="micro-label">Your editor</span>
            <span class="editor-title" id="editor-heading">Customize your AI editor</span>
            <span class="editor-summary">${esc(clippedEditorSummary)}</span>
          </span>
          <span class="editor-state"><strong>${editorCustomized?'Customized':'Default'}</strong> →</span>
        </button>'''
    new = '''        <div class="editor-top"><span class="micro-label">Your editor</span><span class="editor-state">${editorCustomized?'Customized':'Default'}</span></div>
        <h2 class="editor-heading" id="editor-heading"><button class="editor-open" id="open-editor" type="button">Customize your AI editor<span class="editor-arrow" aria-hidden="true">↗</span></button></h2>
        <p class="editor-summary">${esc(clippedEditorSummary)}</p>'''
    assert old in h, 'Unexpected editor template'
    h = h.replace(old, new)
    h = h.replace("textarea:not([disabled])')].filter(el=>!el.closest('[hidden]'));", "textarea:not([disabled]),summary')].filter(el=>!el.closest('[hidden]')&&(!el.closest('details:not([open])')||el===el.closest('details:not([open])').querySelector('summary')));")
    h = h.replace("modal.setAttribute('aria-hidden','false');app.inert=true;", "modal.setAttribute('aria-hidden','false');app.inert=true;document.body.classList.add('dialog-open');")
    h = h.replace("modal.innerHTML='';app.inert=false;", "modal.innerHTML='';app.inert=false;document.body.classList.remove('dialog-open');")
    h = h.replace("document.querySelector('#account-kindle').onclick=()=>state.settings.onboarding_complete?kindleManageModal():onboarding();", "document.querySelector('#account-kindle').onclick=()=>{if(state.settings.onboarding_complete)kindleManageModal();else{closeModal();onboarding()}};")
    h = h.replace('<label>Send-to-Kindle address</label><input class="input" type="email" name="kindle_email"', '<label for="settings-kindle">Send-to-Kindle address</label><input id="settings-kindle" class="input" type="email" name="kindle_email"')
    h = h.replace('<label>Daily delivery time</label><input class="input" type="time" name="delivery_time"', '<label for="settings-time">Daily delivery time</label><input id="settings-time" class="input" type="time" name="delivery_time"')
    h = h.replace('<label>Timezone</label><input class="input" name="timezone"', '<label for="settings-timezone">Timezone</label><input id="settings-timezone" class="input" name="timezone"')
    h = h.replace('<div class="issue-status">', '<div class="issue-status" role="status">')
    h = h.replace('<div class="system-copy">Loading', '<div class="system-copy loading-state" role="status">Loading')
    h = h.replace('<p class="muted">Checking your active feeds…</p>', '<p class="muted loading-state" role="status">Checking your active feeds…</p>')
    h = h.replace('<p class="muted">Loading delivery history…</p>', '<p class="muted loading-state" role="status">Loading delivery history…</p>')
    h = h.replace("modal.querySelector('.modal-card').innerHTML=`<h2>Preview unavailable</h2>", "openModal(`<h2>Preview unavailable</h2>")
    h = h.replace('<button class="btn" id="close-modal">Close</button></div>`;document.querySelector(\'#close-modal\').onclick=closeModal}', '<button class="btn" id="close-modal">Close</button></div>`);document.querySelector(\'#close-modal\').onclick=closeModal}')

styles = {
 'margin-top:3px':'mt-1','margin-top:4px':'mt-1','margin-top:6px':'mt-1','margin-top:7px':'mt-2',
 'margin-top:10px':'mt-2','margin-top:12px':'mt-3','margin-top:14px':'mt-3','margin-top:16px':'mt-4','margin-top:20px':'mt-5',
 'margin-bottom:0':'mb-0','margin-bottom:14px':'mb-3',
 'justify-content:flex-start':'align-start','justify-content:flex-start;margin-top:10px':'align-start mt-2','justify-content:flex-start;margin-top:18px':'align-start mt-5',
 'flex:1;min-width:145px':'form-short','flex:1;min-width:150px':'form-short','flex:2;min-width:210px':'form-wide','flex:2;min-width:220px':'form-wide',
 'max-width:540px;margin-top:14px':'mt-3',
 "margin-top:14px;font-family:Georgia,'Times New Roman',serif;font-size:18px;word-break:break-word":'address mt-3',
 'word-break:break-all;margin:8px 0 18px':'source-address','margin-top:4px;word-break:break-all':'source-address mt-1',
 'margin:18px 0':'my-5','box-shadow:none':'import-row','text-align:left;cursor:pointer':'source-choice','text-decoration:none':'no-underline',
}
def strip_inline(text):
    def replace(m):
        tag, style = m.group(0), m.group(1)
        assert style in styles, style
        classes = styles[style]
        tag = re.sub(r' style="[^"]*"', '', tag)
        if 'class="' in tag:
            tag = tag.replace('class="', f'class="{classes} ', 1)
        else:
            tag = tag.replace('>', f' class="{classes}">', 1)
        return tag
    return re.sub(r'<[^<>]*? style="([^"]*)"[^<>]*>', replace, text)
(root / 'index.html').write_text(strip_inline(h))
o = strip_inline((root / 'opml.js').read_text())
o = o.replace('  modal.querySelector(".modal-card").innerHTML=', '  openModal(')
o = o.replace("    '</div>';\n\n  document.querySelector", "    '</div>');\n\n  document.querySelector")
(root / 'opml.js').write_text(o)
for name in ['privacy', 'terms']:
    text = (root / (name + '.html')).read_text()
    if 'href="/styles.css"' in text:
        continue
    body = re.search(r'<main[^>]*>([\s\S]*?)</main>', text)[1]
    body = body.replace('<a href="/">', '<a class="back-link" href="/">')
    title = name.title()
    (root / (name + '.html')).write_text(f'''<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#f7f5f0">
  <meta name="color-scheme" content="light">
  <title>{title} · Long Form</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body><main class="legal-page">{body}</main></body>
</html>
''')
p = root / 'tests/ui.test.mjs'
t = p.read_text()
marker = "test('primary controls are quiet ink"
if marker in t:
    a = t.index(marker)
    b = t.index('\ntest(', a+5)
    t = t[:a] + '''test('one shared visual system replaces the old inline redesign layers',()=>{
  const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.doesNotMatch(html,/<style>| style=/);
  assert.match(html,/href="\\/styles.css"/);
  for(const token of ['--paper: #f7f5f0','--ink: #28342e','--accent: #913d30'])assert.ok(css.includes(token));
  assert.doesNotMatch(css,/gradient\\(|backdrop-filter|box-shadow|border-radius:\\s*(?:20|22|999)px/);
  assert.match(css,/:focus-visible/);
  assert.match(css,/prefers-reduced-motion/);
});
''' + t[b:]
    p.write_text(t)
print('Refactor applied: no API, publishing, scheduling, authentication, or storage contract changes.')
