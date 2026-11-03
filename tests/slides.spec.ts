import { expect, test, type Page } from "@playwright/test";

/** ROC-AUC each family actually scores. The bar width is the position of that score on a 0.70–0.91 axis. */
const SCORE_ROWS = [
  { board: "table", auc: "0.8908", end: 90.9 },
  { board: "table", auc: "0.8798", end: 85.6 },
  { board: "table", auc: "0.8790", end: 85.2 },
  { board: "table", auc: "0.8595", end: 76.0 },
  { board: "table", auc: "0.8360", end: 64.8 },
  { board: "quantum", auc: "0.8583", end: 75.4 },
  { board: "quantum", auc: "0.8255", end: 59.8 },
  { board: "quantum", auc: "0.8245", end: 59.3 },
  { board: "quantum", auc: "0.7920", end: 43.8 },
  { board: "quantum", auc: "0.7275", end: 13.1 },
] as const;

type Audit = { problems: string[]; slides: number; scale: number };

async function openDeck(page: Page, viewport: { width: number; height: number }, reducedMotion: boolean) {
  await page.setViewportSize(viewport);
  await page.emulateMedia({ reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await page.goto("/", { waitUntil: "load" });
  await page.evaluate(async () => {
    await Promise.all(
      [...document.images].map(
        (img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => resolve();
              })
      )
    );
  });
  await page.waitForFunction(
    () => {
      const card = document.getElementById("protein-card");
      return !card || card.classList.contains("is-3d") || card.classList.contains("is-fallback");
    },
    null,
    { timeout: 20_000 }
  );
}

async function auditSlides(page: Page): Promise<Audit> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const stage = document.getElementById("stage");
    const transform = stage ? getComputedStyle(stage).transform : "none";
    const matrix = transform.match(/matrix\(([^)]+)\)/);
    const zoom = stage ? parseFloat(getComputedStyle(stage).zoom) : 1;
    const scale = matrix ? parseFloat(matrix[1].split(",")[0]) || 1 : Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const slides = [...document.querySelectorAll("article.slide")];

    if (slides.length !== 19) problems.push(`expected 19 slides, found ${slides.length}`);

    slides.forEach((slide) => {
      const id = slide.id || "(no id)";
      if (!slide.querySelector("h1, h2, h3")) problems.push(`${id}: no heading`);
      const label = slide.querySelector(".pg");
      if (!label || !label.textContent?.trim()) problems.push(`${id}: missing page label`);

      slide.querySelectorAll("img").forEach((node) => {
        const img = node as HTMLImageElement;
        const style = getComputedStyle(img);
        if (style.display === "none" || style.visibility === "hidden") return;
        const src = img.getAttribute("src") || "";
        if (!img.complete || img.naturalWidth === 0) {
          problems.push(`${id}: image did not load (${src})`);
          return;
        }
        const box = img.getBoundingClientRect();
        if (box.width < 4 || box.height < 4) {
          problems.push(`${id}: image paints smaller than 4px (${src}, ${Math.round(box.width)}×${Math.round(box.height)})`);
        }
      });

      slide.querySelectorAll<HTMLElement>("h1, h2, h3, h4, p, li, td, th, figcaption").forEach((node) => {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return;
        if (style.position === "absolute" || style.position === "fixed") return;
        const box = node.getBoundingClientRect();
        if (box.height < 2 || box.width < 2) return;
        const clip = clipParent(node);
        if (!clip) return;
        const host = clip.getBoundingClientRect();
        const tol = 3;
        const cutBottom = box.bottom - host.bottom;
        const cutTop = host.top - box.top;
        if (cutBottom > tol || cutTop > tol) {
          const name = clip.id ? `#${clip.id}` : `.${(clip.className && clip.className.toString().split(/\s+/)[0]) || clip.tagName.toLowerCase()}`;
          const text = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 72);
          problems.push(`${id}: “${text}” is cut by ${Math.round(Math.max(cutBottom, cutTop))}px inside ${name}`);
        }
      });
    });

    const card = document.getElementById("protein-card");
    if (card) {
      const still = card.querySelector("img");
      const canvas = card.querySelector("canvas");
      const stillShown = !!still && getComputedStyle(still).visibility !== "hidden" && still.getBoundingClientRect().height >= 8;
      const canvasShown = !!canvas && canvas.getBoundingClientRect().height >= 8;
      if (!stillShown && !canvasShown) problems.push("slide-target: DYRK1A structure is neither drawn nor showing the still");
    }

    function boxOf(selector: string) {
      return [...document.querySelectorAll(selector)].map((el) => {
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      });
    }

    const marks: Array<[string, number, number]> = [
      ["#slide3 .domain .rail", 60, 12],
      ["#slide3 .domain .dot", 10, 10],
      ["#slide3 .domain .tick", 1, 12],
    ];
    marks.forEach(([selector, minW, minH]) => {
      const boxes = boxOf(selector);
      if (boxes.length === 0) {
        problems.push(`${selector} is missing`);
        return;
      }
      boxes.forEach((box) => {
        if (box.w < minW || box.h < minH) {
          problems.push(`${selector} renders at ${Math.round(box.w)}×${Math.round(box.h)}px, needs at least ${minW}×${minH}px`);
        }
      });
    });

    const chart = document.querySelector("#slide3 .chart");
    const outside = document.querySelector("#slide3 .domain .dot.out");
    const rail = document.querySelector("#slide3 .domain .rail");
    if (outside && rail) {
      const edge = getComputedStyle(outside).borderTopColor;
      const fill = getComputedStyle(rail).backgroundColor;
      if (contrast(edge, fill) < 3) {
        problems.push(`outside dot does not separate from the bar (contrast ${contrast(edge, fill).toFixed(2)})`);
      }
    }

    if (chart) {
      document.getElementById("slide3")?.scrollIntoView({ block: "center" });
      const paper = getComputedStyle(chart).backgroundColor;
      const host = chart.getBoundingClientRect();
      document.querySelectorAll("#slide3 .domain .rail").forEach((node, index) => {
        const bar = node as HTMLElement;
        const box = bar.getBoundingClientRect();
        if (!paintedInside(box, host, 0.9)) {
          problems.push(`applicability rail ${index + 1} is clipped by the chart`);
        }
        const track = contrast(getComputedStyle(bar).backgroundColor, paper);
        const near = bar.querySelector(".near");
        const zone = near ? contrast(getComputedStyle(near).backgroundColor, paper) : 0;
        if (track < 1.5) problems.push(`applicability track fades into the card (contrast ${track.toFixed(2)})`);
        if (zone < 3) problems.push(`applicability inside-zone fades into the card (contrast ${zone.toFixed(2)})`);
        const probe = document.elementFromPoint(box.left + box.width * 0.3, box.top + box.height / 2);
        if (!probe || !bar.contains(probe)) {
          const name = probe ? probe.className.toString().split(/\s+/)[0] || probe.tagName : "nothing";
          problems.push(`applicability rail ${index + 1} is covered by ${name}`);
        }
      });
      document.querySelectorAll("#slide3 .domain .who, #slide3 .domain .verdict").forEach((node) => {
        const el = node as HTMLElement;
        const box = el.getBoundingClientRect();
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (box.height < 8 || box.width < 40) {
          problems.push(`applicability label “${text}” renders at ${Math.round(box.width)}×${Math.round(box.height)}px`);
        }
        if (!paintedInside(box, host, 0.9)) problems.push(`applicability label “${text}” is clipped by the chart`);
      });
      const labels = [...document.querySelectorAll("#slide3 .domain .who, #slide3 .domain .verdict")]
        .map((node) => (node as HTMLElement).innerText || "")
        .join(" ");
      ["Classical", "Quantum", "Outside", "Inside"].forEach((word) => {
        if (!labels.includes(word)) problems.push(`applicability chart is missing “${word}”`);
      });
      const chartBox = chart.getBoundingClientRect();
      if (chartBox.right > window.innerWidth + 1 || chartBox.left < -1) {
        problems.push(`applicability chart sits outside the window (${Math.round(chartBox.left)}–${Math.round(chartBox.right)} of ${window.innerWidth})`);
      }
    }

    return { problems, slides: slides.length, scale };

    function paintedInside(box: DOMRect, host: DOMRect, minRatio: number) {
      const width = Math.min(box.right, host.right) - Math.max(box.left, host.left);
      const height = Math.min(box.bottom, host.bottom) - Math.max(box.top, host.top);
      const area = Math.max(0, width) * Math.max(0, height);
      const own = box.width * box.height;
      return own > 0 && area / own >= minRatio;
    }

    function clipParent(node: HTMLElement) {
      let parent = node.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        if (style.overflowY === "hidden" || style.overflowY === "clip" || style.overflowX === "hidden" || style.overflowX === "clip") {
          return parent;
        }
        parent = parent.parentElement;
      }
      return null;
    }

    function contrast(a: string, b: string) {
      const ratio = (color: string) => {
        const m = color.match(/[\d.]+/g);
        if (!m) return 0;
        const [r, g, b] = m.map(Number);
        const lin = [r, g, b].map((v) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
      };
      const l1 = ratio(a);
      const l2 = ratio(b);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    }
  });
}

for (const viewport of [
  { name: "design", width: 1920, height: 1080 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "narrow", width: 980, height: 700 },
  { name: "split", width: 800, height: 600 },
] as const) {
  test(`every slide shows its text, images, and marks @ ${viewport.name}`, async ({ page }) => {
    await openDeck(page, viewport, true);
    const audit = await auditSlides(page);
    expect(audit.slides).toBe(19);
    expect(audit.problems, audit.problems.join("\n")).toEqual([]);
  });
}

test("model bars stay at their scored width when motion is reduced", async ({ page }) => {
  await openDeck(page, { width: 1920, height: 1080 }, true);
  const rows = page.locator("#slide-score .board .row");
  await expect(rows).toHaveCount(SCORE_ROWS.length);
  for (let i = 0; i < SCORE_ROWS.length; i++) {
    const spec = SCORE_ROWS[i];
    const row = rows.nth(i);
    const board = await row.evaluate((el) => (el.closest(".board")?.classList.contains("quantum") ? "quantum" : "table"));
    expect(board).toBe(spec.board);
    await expect(row.locator(".auc")).toHaveText(spec.auc);
    const ratio = await row.locator(".track i").evaluate((bar) => {
      const track = bar.parentElement!.getBoundingClientRect().width;
      const end = parseFloat(getComputedStyle(bar).getPropertyValue("--end"));
      const width = bar.getBoundingClientRect().width;
      return { widthRatio: track ? width / track : 0, end };
    });
    expect(ratio.end).toBeCloseTo(spec.end, 1);
    expect(ratio.widthRatio).toBeGreaterThan(spec.end / 100 - 0.03);
  }
});

test("model bars fill from empty and each ROC-AUC counts from 0.000", async ({ page }) => {
  await openDeck(page, { width: 1920, height: 1080 }, false);
  await page.locator("#slide-score").scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const replay = (window as unknown as { __replayScoreBars?: () => void }).__replayScoreBars;
    if (!replay) throw new Error("score animation hook is missing");
    replay();
  });
  await page.waitForFunction(() => {
    const bars = [...document.querySelectorAll("#slide-score .board .track i")];
    return bars.length === 10 && bars.every((bar) => bar.getAnimations().length > 0);
  });

  const start = await page.evaluate(() => {
    const sync = (window as unknown as { __syncScoreReadout?: () => void }).__syncScoreReadout;
    document.querySelectorAll("#slide-score .board .track i").forEach((node) => {
      const bar = node as HTMLElement;
      const anim = bar.getAnimations()[0];
      anim.pause();
      anim.currentTime = 0;
    });
    sync?.();
    return [...document.querySelectorAll("#slide-score .board .row")].map((row) => {
      const bar = row.querySelector(".track i") as HTMLElement;
      const track = (row.querySelector(".track") as HTMLElement).getBoundingClientRect().width;
      return {
        auc: row.querySelector(".auc")?.textContent?.trim(),
        widthRatio: track ? bar.getBoundingClientRect().width / track : 1,
      };
    });
  });

  expect(start).toHaveLength(SCORE_ROWS.length);
  start.forEach((row) => {
    expect(row.auc).toBe("0.0000");
    expect(row.widthRatio).toBeLessThan(0.04);
  });

  const end = await page.evaluate(() => {
    const sync = (window as unknown as { __syncScoreReadout?: () => void }).__syncScoreReadout;
    document.querySelectorAll("#slide-score .board .track i").forEach((node) => {
      const bar = node as HTMLElement;
      const anim = bar.getAnimations()[0];
      const timing = anim.effect?.getComputedTiming();
      anim.currentTime = timing?.endTime ?? 2000;
    });
    sync?.();
    return [...document.querySelectorAll("#slide-score .board .row")].map((row) => {
      const bar = row.querySelector(".track i") as HTMLElement;
      const track = (row.querySelector(".track") as HTMLElement).getBoundingClientRect().width;
      return {
        auc: row.querySelector(".auc")?.textContent?.trim(),
        widthRatio: track ? bar.getBoundingClientRect().width / track : 0,
      };
    });
  });

  end.forEach((row, i) => {
    expect(row.auc).toBe(SCORE_ROWS[i].auc);
    expect(row.widthRatio).toBeGreaterThan(SCORE_ROWS[i].end / 100 - 0.03);
    expect(row.widthRatio).toBeLessThan(SCORE_ROWS[i].end / 100 + 0.03);
  });
});

test("presentation walks every slide as a single current frame", async ({ page }) => {
  await openDeck(page, { width: 1440, height: 900 }, true);
  await page.getByRole("button", { name: "Presentar" }).click();
  await expect(page.locator("body")).toHaveClass(/presenting/);
  const count = await page.locator("article.slide").count();
  expect(count).toBe(19);
  for (let i = 0; i < count; i++) {
    const current = page.locator("article.slide.is-current");
    await expect(current).toHaveCount(1);
    const box = await current.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(400);
    expect(box?.height ?? 0).toBeGreaterThan(200);
    const heading = current.locator("h1, h2, h3").first();
    await expect(heading).toBeVisible();
    if (i < count - 1) await page.keyboard.press("ArrowRight");
  }
});
