// Dates et jours : formats français, calculs de calendrier, frise des dates de tournée.

import type { Database } from "./database.types.js";

type TourTag = Database["public"]["Tables"]["tour_tags"]["Row"];

export const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
export const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
export const dayKey = (d: Date): string => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
export const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function dayLabel(date: Date): string {
  const diff = Math.round((startOfDay(new Date()).getTime() - startOfDay(date).getTime()) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === 1) return "Hier";
  return dayFmt.format(date);
}

export const shortDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso + "T00:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" }) : "";

export const pad2 = (n: number): string => String(n).padStart(2, "0");
export const toISO = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const fromISO = (iso: string): Date => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (d: Date, n: number): Date => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};
export const mondayOf = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));
export const weekdayShort = (d: Date): string => d.toLocaleDateString("fr-FR", { weekday: "short" });
export const monthLabel = (d: Date): string => {
  const text = d.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// « 12 mars 2027 », « 12–14 mars 2027 » ou « 28 févr. → 2 mars 2027 »
export function rangeText(tag: Pick<TourTag, "start_date" | "end_date">): string {
  if (!tag.start_date) return "";
  const a = fromISO(tag.start_date);
  const b = fromISO(tag.end_date || tag.start_date);
  if (toISO(a) === toISO(b)) return shortDate(tag.start_date);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
    return `${a.getDate()}–${b.getDate()} ${b.toLocaleDateString("fr-FR", { month: "short", year: "numeric" })}`;
  }
  return `${shortDate(tag.start_date)} → ${shortDate(tag.end_date)}`;
}

// Attribue une ligne (frise) à chaque date de tournée : deux plages qui se chevauchent ne partagent pas de ligne.
export function assignLanes(tags: Pick<TourTag, "id" | "start_date" | "end_date">[]): Map<string, number> {
  const lanes = new Map<string, number>();
  const ends: string[] = [];
  const dated = tags
    .filter((t) => t.start_date)
    .sort((a, b) => (a.start_date as string).localeCompare(b.start_date as string) || (b.end_date as string).localeCompare(a.end_date as string));
  for (const tag of dated) {
    const start = tag.start_date as string;
    let lane = ends.findIndex((end) => end < start);
    if (lane === -1) lane = ends.length;
    ends[lane] = tag.end_date as string;
    lanes.set(tag.id, lane);
  }
  return lanes;
}
