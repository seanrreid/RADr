// TorchCodeLab report theme for radr (PRD §12). Derived from torchcodelab.com:
// primary #f1362a, accent #ac1694, gradient #b81c83 → #ac1694, base #040404 / #2f2929;
// Raleway (headings) + Montserrat (body). Dark cover, light printable body pages.
//
// radr provides: meta.json (document metadata) and body.typ (pandoc's Typst output).
// The theme's content hash is frozen at Gate 2, so a theme change requires re-approval.

#let meta = json("meta.json")

#let primary = rgb("#f1362a")
#let accent = rgb("#ac1694")
#let gradient-start = rgb("#b81c83")
#let ink = rgb("#040404")
#let warm = rgb("#2f2929")
#let body-text = rgb("#1d1b1b")
#let muted = rgb("#6b6566")
#let rule = gradient.linear(gradient-start, accent, primary)

#let date-parts = meta.date.split("-").map(int)
#set document(
  title: meta.title,
  author: "Torch Code Lab",
  date: datetime(year: date-parts.at(0), month: date-parts.at(1), day: date-parts.at(2)),
)

#set text(font: "Montserrat", size: 9.5pt, fill: body-text, lang: "en")
#set par(justify: false, leading: 0.62em, spacing: 1.0em)
#show raw: set text(font: "DejaVu Sans Mono", size: 8pt)
// Inline code (paths, rule ids) must wrap inside narrow table columns instead of running into
// the next one: allow a break after path and name separators. The Markdown keeps plain text.
#show raw.where(block: false): it => text(font: "DejaVu Sans Mono", size: 8pt, it.text.replace(regex("[/.:_-]"), m => m.text + "\u{200b}"))

#set page(
  paper: "us-letter",
  margin: (x: 2.1cm, top: 2.5cm, bottom: 2.2cm),
  header: context {
    if counter(page).get().first() > 1 [
      #set text(size: 7.5pt, fill: muted)
      #box(height: 0.9em, image("logo.jpg"))
      #h(0.4em) Torch Code Lab #h(1fr) #meta.title
      #v(-0.5em)
      #line(length: 100%, stroke: 0.6pt + rule)
    ]
  },
  footer: context {
    if counter(page).get().first() > 1 [
      #set text(size: 7.5pt, fill: muted)
      Confidential · prepared for #meta.client · run #meta.run · commit #raw(meta.commit.slice(0, 12))
      #h(1fr) #counter(page).display("1 / 1", both: true)
    ]
  },
)

// Headings
#show heading: set text(font: "Raleway", fill: ink)
// Sections flow; only the long reference sections start a new page.
#let page-starts = ("Findings", "Methodology", "Appendix: all findings")
#let plain(c) = if c.has("text") { c.text } else if c.has("children") { c.children.map(plain).join() } else if c == [ ] { " " } else { "" }
#show heading.where(level: 1): it => {
  if page-starts.contains(plain(it.body)) { pagebreak(weak: true) } else { v(0.9em) }
  block(below: 0.9em)[
    #text(size: 20pt, weight: 900)[#it.body]
    #v(-0.55em)
    #box(width: 3.2cm, height: 3pt, fill: rule)
  ]
}
#show heading.where(level: 2): it => block(above: 1.4em, below: 0.7em, text(size: 13pt, weight: 700)[#it.body])
#show heading.where(level: 3): it => block(above: 1.2em, below: 0.6em, text(size: 11pt, weight: 700, fill: warm)[#it.body])

// Tables: pandoc wraps them in figures; long finding tables must break across pages.
#show figure: set block(breakable: true)
#show figure.where(kind: table): set figure(supplement: none, numbering: none)
#set table(
  stroke: (x, y) => (bottom: 0.4pt + rgb("#e3dede")),
  inset: (x: 5pt, y: 4.5pt),
  fill: (x, y) => if y == 0 { warm } else if calc.even(y) { rgb("#faf7f7") } else { white },
)
#show table.cell: set text(size: 8pt)
#show table.cell: set align(left)  // pandoc centers the table; cells read better left-aligned
#show table.cell.where(y: 0): set text(fill: white, weight: 700, size: 8pt)
#show table.cell: it => {
  // Severity words carry their color inside tables only (prose stays neutral).
  show regex("^critical$"): set text(fill: primary, weight: 700)
  show regex("^high$"): set text(fill: accent, weight: 700)
  show regex("^medium$"): set text(fill: rgb("#b26a00"), weight: 700)
  show regex("^At risk$"): set text(fill: primary, weight: 700)
  show regex("^Watch$"): set text(fill: rgb("#b26a00"), weight: 700)
  show regex("^Good$"): set text(fill: rgb("#1f7a4d"), weight: 700)
  it
}
#show strong: set text(weight: 700)
#show link: set text(fill: accent)

// Pandoc helper used for thematic breaks.
#let horizontalrule = line(length: 100%, stroke: 0.6pt + rule)

// Cover
#page(fill: ink, margin: 0pt, header: none, footer: none)[
  #set text(fill: white)
  #place(top + left, box(width: 100%, height: 6pt, fill: rule))
  #align(center)[
    #v(1.6cm)
    #image("logo.jpg", height: 9.6cm)
    #v(0.8cm)
    #text(font: "Raleway", size: 26pt, weight: 900)[#meta.heading]
    #v(0.2cm)
    #text(size: 12pt, fill: rgb("#d9d2d2"))[#meta.client · #meta.engagement_label]
    #v(0.7cm)
    #if meta.verdict != "n/a" [
      #box(fill: rule, inset: (x: 14pt, y: 7pt), radius: 3pt)[#text(size: 11pt, weight: 700)[Overall: #meta.verdict]]
      #v(0.5cm)
    ]
    #text(size: 9pt, fill: rgb("#bdb4b4"))[
      #meta.date · run #meta.run · commit #raw(meta.commit.slice(0, 12))
    ]
    #if meta.accepted_partial != none [
      #v(0.6cm)
      #block(width: 70%, inset: 9pt, stroke: 1pt + primary, radius: 3pt)[
        #set text(size: 8.5pt, fill: white)
        #text(weight: 700)[Partial review.] Some analysis lanes did not complete. Accepted at sign-off because: #meta.accepted_partial
      ]
    ]
  ]
  #place(bottom + center, dy: -1.2cm)[
    #text(size: 7.5pt, fill: rgb("#8f8585"))[Torch Code Lab · Sean R Reid, L.L.C. · Confidential]
  ]
]

#include "body.typ"
