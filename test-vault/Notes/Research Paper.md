---
title: Research Paper
tags: [draft]
---
# Decision Making Under Uncertainty

This draft looks at how people judge probability. It mixes **bold**, *italic*, ***both***, ~~struck~~, ==highlighted== and `inline code` text, plus a [link to the docs](https://help.obsidian.md) and a wikilink to [[Glossary|the glossary]].%% hidden comment %%

Fast and slow thinking is described by @kahneman2011, and the classic heuristics paper is often cited [@tversky1974, p. 1125]. Later work extended it [see @smith2020; @kahneman2011, pp. 33-35].

## Model

The expected value of a gamble is $E[X] = \sum_{i=1}^{n} p_i x_i$ where each $p_i \ge 0$ and $\sum p_i = 1$.

$$
U(x) = \begin{cases} x^{\alpha} & x \ge 0 \\ -\lambda (-x)^{\beta} & x < 0 \end{cases}
$$

The probability weighting function is

$$\pi(p) = \frac{p^{\gamma}}{\left(p^{\gamma} + (1-p)^{\gamma}\right)^{1/\gamma}}$$

and a matrix form of the update:

$$
\begin{bmatrix} a_{11} & a_{12} \\ a_{21} & a_{22} \end{bmatrix} \begin{pmatrix} x \\ y \end{pmatrix} = \sqrt{\frac{\int_0^\infty e^{-t^2}\,dt}{\hat{\theta}}}
$$

> [!note] Why this matters
> People do not weigh losses and gains the same way.[^1]
> - Losses loom larger
> - Small probabilities are overweighted

> [!warning]- Check the data first
> Results below use a small sample.

## Method

![[Methods#Sampling]]

Steps we followed:

1. Collect notes
2. Clean them
   1. Remove duplicates
   2. Fix dates
      - keep ISO format
      - drop empty rows
3. Analyse

A second list restarts its numbering:

1. First again
2. Second

3. Third (loose list item)

   With a second paragraph inside the item.

- [ ] Write discussion
- [x] Draft method

| Variable | Mean | SD | Note |
|:---------|-----:|:--:|------|
| Reaction time (s) | 2.31 | 0.42 | lower is better |
| Accuracy | 0.87 | 0.05 | proportion correct |
| $\alpha$ | 0.88 | — | from @tversky1974 |

![[chart.png]]

![A photo|300](../attachments/photo%20sample.jpg)

```python
def expected_value(ps, xs):
    return sum(p * x for p, x in zip(ps, xs))
```

> Plain quotes still look like quotes.
> — Someone

---

A key definition: ![[Glossary#^loss-aversion]]

[^1]: See the original prospect theory paper for the full model.

<!-- bibliography -->
