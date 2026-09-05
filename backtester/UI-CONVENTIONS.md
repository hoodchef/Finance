# Interface conventions

The single target every page is written to. These are not preferences — they
are the patterns already in the codebase, written down so parallel work does
not drift into four dialects of the same interface.

## Page frame

Every route renders `PageHeader` then `PageBody` from
`@/components/layout/app-shell`.

```tsx
<PageHeader title="Research" description="One line. What the page answers." actions={…} />
<PageBody className="space-y-4">…</PageBody>
```

Content sits in `Card` / `CardHeader` / `CardTitle` / `CardContent`. Do not
invent container components.

## Type scale

`text-2xs` is **11px**. It is correct for a unit suffix, an uppercase stat
label, or a table micro-header. It is **never** correct for a sentence.

| Use | Class |
| --- | --- |
| Page title | `text-xl font-semibold tracking-tight` (via `PageHeader`) |
| Card title | `text-sm` on `CardTitle` |
| Section heading inside a card | `text-2xs font-semibold uppercase tracking-wide text-muted-foreground` |
| Prose, hints, explanations | `text-xs leading-relaxed text-muted-foreground` |
| Table body | `text-xs` |
| Stat label | `text-2xs font-medium uppercase tracking-wide text-muted-foreground` |
| Stat value | `numeric font-semibold text-lg` — `text-2xl` for a headline figure |
| Unit suffix, micro-note | `text-2xs text-muted-foreground` |

Any element containing a figure meant to line up in a column carries
`numeric`.

## Colour

Tokens only. Never a hex value, never a Tailwind palette colour
(`text-red-500`, `bg-blue-100`). There are four themes — light, dark, terminal
and bloomberg — and a hardcoded colour is invisible or illegible in at least
one of them.

- Gain / good: `text-positive`
- Loss / warning: `text-negative`
- Secondary text: `text-muted-foreground`
- Borders: `border-border`, dividers `border-border/50`
- Quiet fill: `bg-muted/40`
- Chart series: `var(--series-0)` … `var(--series-14)`, or `seriesColor()` from
  `@/lib/utils`

The series tokens are **hex literals, not HSL triplets**, so they are used bare:
`hsl(var(--series-4))` becomes `hsl(#fb7185)`, which is invalid CSS and computes
to `none`. The failure is silent — the shape renders with no colour at all — and
it shipped on three pages before anyone noticed a chart had gone blank.

Use the shorthand utilities, defined in `globals.css`. The verbose
`text-[hsl(var(--positive))]` form works but is the minority spelling, and the
bloomberg theme's numeric override is written against those class names — keep
them recognisable.

## Stats

Use the shared `Stat` from `@/components/ui/stat`. It already carries the
label, value, optional sub-line, sign colouring and info tip at the right type
scale — do not hand-roll a local one, and do not restyle its internals.

The house grouping is a hairline-separated tile strip, which reads as one
block and stays legible from two columns up to five:

```tsx
<div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
  <Stat className="bg-card" size="lg" label="CAGR" value={…} tone={toneOf(x)} />
```

In a narrow sidebar column where a tile strip cannot breathe, a plain
`grid grid-cols-2 gap-x-4 gap-y-2.5` with groups separated by
`border-t border-border pt-3` is the fallback.

Either way the rule is the same: **never a long single column of full-width
stat rows.** Twelve of those made a panel twice the height of the chart beside
it and pushed the page's controls off the screen.

## Tables

```tsx
<div className="overflow-x-auto">
  <table className="w-full text-xs">
    <thead>
      <tr className="border-b border-border text-left text-muted-foreground">
        <th className="py-2 pr-3 font-medium">…</th>
    <tbody>
      <tr className="border-b border-border/50 last:border-0">
        <td className="numeric py-1.5 pr-3 text-right">…</td>
```

Numeric columns are right-aligned and carry `numeric`. A `min-w-[Nrem]` forces
horizontal scrolling — justify every column before adding one, and prefer
dropping a column to widening the table.

## Empty states

An empty panel must never assert a value. "Max loss: UNLIMITED" with nothing
entered was a real bug here: the summary returned `null` for "nothing to
compute" and the panel rendered `null` as unbounded.

Say what the reader should do instead: *"Add a leg to see the payoff."*

## Provenance and caveats

This application states where its numbers came from and what they assume. That
text is load-bearing — restyle or reposition it, never delete or soften it.

```tsx
<p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
```

Distinguish, always: market data, a modelled value, an estimate, a simulated
value. Never present one as another, and never fabricate data to fill a gap —
an absent number with a reason beats a plausible invented one.

## Density

This is an analytics product and density is appropriate, but the answer must
be findable. The most important figure on a panel outranks its inputs
visually. If everything is the same weight, nothing reads as the answer.
