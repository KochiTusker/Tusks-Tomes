// Click-to-load YouTube facade.
//
// Nothing is requested from any third party until the visitor deliberately
// clicks play. That keeps the page free of third-party cookies on load, keeps
// it fast even with several embeds of the same video, and means the site needs
// no cookie banner.
//
// This lives in an external file rather than inline so the Content-Security-
// Policy can be `script-src 'self'` with no 'unsafe-inline' — an inline script
// would force the policy open for every script on the page.
//
// Uses only DOM APIs: no innerHTML, no document.write, no eval. The video id
// comes from a data attribute the generator wrote, and is URL-encoded anyway.

/** Swap a facade for the real embed, optionally bounded to a section. */
function loadVideo(wrap, start, end) {
  var id = wrap.getAttribute('data-video-id')
  if (!id) return
  var params = ['autoplay=1', 'rel=0']
  if (start) params.push('start=' + encodeURIComponent(start))
  if (end) params.push('end=' + encodeURIComponent(end))
  var frame = document.createElement('iframe')
  frame.src =
    'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(id) + '?' + params.join('&')
  frame.title = 'Tusk’s Tomes demo video'
  frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture'
  frame.allowFullscreen = true
  frame.loading = 'lazy'
  wrap.replaceChildren(frame)
}

document.querySelectorAll('.video').forEach(function (wrap) {
  var btn = wrap.querySelector('.video-play')
  if (!btn) return
  btn.addEventListener('click', function () {
    loadVideo(wrap, wrap.getAttribute('data-start'), wrap.getAttribute('data-end'))
  })
})

// Chapter index. Clicking a timestamp plays that section in the main demo
// player rather than sending the visitor off to YouTube — they keep their
// place on the page, and the facade's privacy behaviour is unchanged (still
// no third-party request until this click).
var mainVideo = document.querySelector('#demo .video')
document.querySelectorAll('.chapter').forEach(function (btn) {
  btn.addEventListener('click', function () {
    if (!mainVideo) return
    loadVideo(mainVideo, btn.getAttribute('data-start'), btn.getAttribute('data-end'))
    document.querySelectorAll('.chapter').forEach(function (b) {
      b.setAttribute('aria-current', b === btn ? 'true' : 'false')
    })
    // Only scroll if the player isn't already on screen — jumping the page
    // when the video is right there is disorienting.
    var box = mainVideo.getBoundingClientRect()
    if (box.top < 0 || box.bottom > window.innerHeight) {
      mainVideo.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  })
})

/* Documentation filter.
 *
 * Built here rather than in the HTML, deliberately. The full grouped index is
 * already in the markup and is what crawlers and no-JS readers get; the filter
 * is pure enhancement, so it should not exist in the document at all unless it
 * works. The alternatives are both worse: a control shipped visible-but-dead
 * reads as a broken page, and one shipped `hidden` is indistinguishable from a
 * forgotten note or an injected payload — which the site's own audit flags,
 * correctly, without needing to learn which hidden elements are benign.
 *
 * Matching is substring over a pre-lowercased `title + summary` baked into
 * each item at build time — no per-keystroke DOM reads. Substring rather than
 * fuzzy on purpose: "cost" should not surface "Codex" on a shared c-o.
 * Someone filtering three dozen pages wants the ones that say the word.
 */
;(function () {
  var index = document.querySelector('.doc-index')
  if (!index) return

  var items = [].slice.call(index.querySelectorAll('.doc-item'))
  var groups = [].slice.call(index.querySelectorAll('.doc-group'))
  if (items.length < 2) return

  var wrap = document.createElement('div')
  wrap.className = 'doc-filter'

  var label = document.createElement('label')
  label.className = 'doc-filter-label'
  label.htmlFor = 'doc-filter-input'
  label.textContent = 'Filter the documentation'

  var input = document.createElement('input')
  input.id = 'doc-filter-input'
  input.type = 'search'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.placeholder = 'Search ' + items.length + ' pages — try "whisper" or "cost"'

  var count = document.createElement('p')
  count.className = 'doc-filter-count'
  // Announced rather than shown-and-ignored: a screen-reader user filtering a
  // list needs to hear that the list changed under them.
  count.setAttribute('role', 'status')
  count.setAttribute('aria-live', 'polite')

  wrap.appendChild(label)
  wrap.appendChild(input)
  wrap.appendChild(count)
  index.insertBefore(wrap, index.firstChild)

  function apply() {
    var q = input.value.trim().toLowerCase()
    var shown = 0

    items.forEach(function (li) {
      var hit = !q || (li.getAttribute('data-search') || '').indexOf(q) !== -1
      li.hidden = !hit
      if (hit) shown++
    })

    // Hide a group whose every child is filtered out, or the page becomes a
    // column of empty headings.
    groups.forEach(function (g) {
      var any = [].slice.call(g.querySelectorAll('.doc-item')).some(function (li) {
        return !li.hidden
      })
      g.hidden = !any
    })

    if (!q) count.textContent = ''
    else if (shown === 0) count.textContent = 'No pages match — try a shorter word.'
    else count.textContent = shown + (shown === 1 ? ' page' : ' pages') + ' match'
  }

  input.addEventListener('input', apply)
  input.addEventListener('keydown', function (e) {
    // Escape clears rather than blurring. Blurring is the browser default for
    // type=search in some engines and it leaves the list filtered with focus
    // gone, which is the worst of both.
    if (e.key === 'Escape' && input.value) {
      input.value = ''
      apply()
      e.preventDefault()
    }
  })
})()
