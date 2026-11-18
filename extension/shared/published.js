export function compactTitle(value) {
  return String(value || "")
    .replace(/[#＃][^\s#＃]+/g, "")
    .replace(/[\s\u3000·.,，。!！?？:：'"“”‘’\-—_]/g, "")
    .toLowerCase();
}
export function titlesMatch(expected, listed) {
  const a = compactTitle(expected);
  const b = compactTitle(listed);
  if (a.length < 4 || b.length < 4) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  return (
    long.startsWith(short) &&
    short.length >= 6 &&
    short.length / long.length >= 0.6
  );
}
export function parseCount(value) {
  const text = String(value || "")
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  const match = text.match(/(\d+(?:\.\d+)?)(万|亿|w|k|m)?/i);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2];
  if (unit === "万" || unit === "w") return Math.round(n * 10000);
  if (unit === "亿") return Math.round(n * 1e8);
  if (unit === "k") return Math.round(n * 1000);
  if (unit === "m") return Math.round(n * 1e6);
  return Math.round(n);
}
export function formatLikes(value) {
  if (!Number.isFinite(value)) return "";
  if (value >= 10000) {
    const shown =
      value >= 100000
        ? Math.round(value / 10000)
        : Math.round(value / 1000) / 10;
    return String(shown).replace(/\.0$/, "") + "万赞";
  }
  return value + "赞";
}
export function matchPublished(entries, items) {
  const results = {};
  for (const entry of entries) {
    const hits = items.filter((item) => titlesMatch(entry.title, item.title));
    const exact = hits.filter(
      (item) => compactTitle(entry.title) === compactTitle(item.title),
    );
    const chosen = exact.length === 1 ? exact : hits;
    if (chosen.length !== 1) {
      results[entry.id] = {
        found: false,
        reason: hits.length > 1 ? "标题不唯一" : "列表里没有同名标题",
      };
      continue;
    }
    const hit = chosen[0];
    const collided = entries.some(
      (other) => other.id !== entry.id && titlesMatch(other.title, hit.title),
    );
    if (collided) {
      results[entry.id] = { found: false, reason: "标题和其他内容撞了" };
      continue;
    }
    results[entry.id] = {
      found: true,
      likes: Number.isFinite(hit.likes) ? hit.likes : parseCount(hit.likesText),
      href: hit.href || "",
      title: hit.title,
    };
  }
  return results;
}
