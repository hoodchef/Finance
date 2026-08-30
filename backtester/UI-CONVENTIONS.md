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
| Stat label | `text-2xs uppercase tracking-wide text-muted-foreground` |
| Stat value | `numeric text-sm font-medium` — `text-lg` for a headline figure |
| Unit suffix, micro-note | `text-2xs text-muted-foreground` |

Any element containing a figure meant to line up in a column carries
`numeric`.

## Colour

Tokens only. Never a hex value, never a Tailwind palette colour
(`text-red-500`, `bg-blue-100`). There are four themes — light, dark, terminal
and bloomberg — and a hardcoded colour is invisible or illegible in at least
one of them.

- Gain / good: `text-[hsl(var(--positive))]`
- Loss / warning: `text-[hsl(var(--negative))]`
- Secondary text: `text-muted-foreground`
- Borders: `border-border`, dividers `border-border/50`
- Quiet fill: `bg-muted/40`
- Chart series: `hsl(var(--series-0))` … `hsl(var(--series-14))`

## Stats

Label above value. Grouped in a grid, never a long single column — a stack of
twelve full-width rows makes a panel twice the height of the chart beside it
and pushes everything else off the screen.

```tsx
<div className="grid grid-cols-2 gap-x-4 gap-y-2.5">…</div>
<div className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3">…</div>
```

Related groups are separated by `border-t border-border pt-3`, not by headings.

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
