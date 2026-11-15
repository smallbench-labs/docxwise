# Images and code

SVG:

![[diagram.svg]]

WebP:

![[sample.webp|400]]

```python
# Expected value of a lottery
def expected_value(ps: list[float], xs: list[float]) -> float:
    """Return the probability-weighted sum."""
    return sum(p * x for p, x in zip(ps, xs))  # 0.0 if empty
```

```ts
export async function load(path: string): Promise<string | null> {
	const file = app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? app.vault.read(file) : null; // TODO: cache
}
```

```
plain block without a language stays uncoloured
```
