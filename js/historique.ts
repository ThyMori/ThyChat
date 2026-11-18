// Historique des notifications (la cloche) : ce que la personne a reçu, avec l'heure, pendant 30 jours.
// Les lignes sont écrites par la fonction serveur « send-push » (table notification_log, migration 033) ;
// ici on les lit, on les affiche, on les marque comme lues et on les efface.
// La logique pure (regroupement par jour, comptage) est séparée de l'affichage pour pouvoir être testée.

import { $, el, openDialog, closeDialog } from "./dom.js";
import { dayKey, dayLabel, timeFmt } from "./dates.js";
import type { Database } from "./database.types.js";
import type { Db } from "./types.js";

export type LogEntry = Database["public"]["Tables"]["notification_log"]["Row"];

// Nombre de notifications non lues.
export const unreadCount = (entries: LogEntry[]): number => entries.filter((e) => !e.read_at).length;

// Regroupe les notifications par jour (les plus récentes d'abord), avec « Aujourd'hui » / « Hier ».
export function groupByDay(entries: LogEntry[], now: Date = new Date()): { label: string; entries: LogEntry[] }[] {
  const groups: { key: string; label: string; entries: LogEntry[] }[] = [];
  const sorted = [...entries].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  for (const entry of sorted) {
    const date = new Date(entry.created_at);
    const key = dayKey(date);
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, label: dayLabel(date), entries: [] };
      groups.push(group);
    }
    group.entries.push(entry);
  }
  void now; // (réservé : le libellé du jour se calcule par rapport à l'heure courante dans dayLabel)
  return groups.map(({ label, entries: list }) => ({ label, entries: list }));
}

const KIND_ICON: Record<string, string> = { message: "💬", dm: "✉️", doc: "📄" };

export interface HistoryOptions {
  supabase: Db;
  userId: string;
  // Ouvre le sous-salon d'une notification (espace, sous-salon).
  open: (workspaceId: string, channelId: string | null) => void;
}

export function createHistory({ supabase, userId, open }: HistoryOptions) {
  let entries: LogEntry[] = [];
  let available = true; // faux si la table n'existe pas encore (migration 033 pas collée)
  let freshIds = new Set<string>(); // lignes non lues au moment de l'ouverture : mises en valeur dans la liste

  // Pastille rouge sur la cloche (et sur le bouton ☰ du téléphone) quand il y a du nouveau.
  function renderBadge(): void {
    const has = unreadCount(entries) > 0;
    for (const id of ["#open-history", "#open-sidebar"]) $(id).classList.toggle("has-new", has);
    $("#open-history").setAttribute("aria-label", has ? `Notifications reçues, ${unreadCount(entries)} non lue(s)` : "Notifications reçues");
  }

  function renderList(): void {
    const box = $("#history-list");
    box.replaceChildren();
    $("#history-clear").hidden = !entries.length;
    if (!available) {
      box.append(el("p", "muted", "L'historique des notifications n'est pas encore disponible sur ce serveur."));
      return;
    }
    if (!entries.length) {
      box.append(el("p", "muted", "Aucune notification pour l'instant. Tu retrouveras ici, pendant 30 jours, ce que tu as reçu."));
      return;
    }
    for (const group of groupByDay(entries)) {
      box.append(el("h4", "history-day", group.label));
      for (const entry of group.entries) {
        const row = el("button", "history-row" + (freshIds.has(entry.id) ? " fresh" : ""), "");
        row.type = "button";
        row.dataset.id = entry.id;
        const text = el("span", "history-text", "");
        text.append(el("strong", "", entry.title), el("span", "history-body", entry.body));
        row.append(el("span", "history-ic", KIND_ICON[entry.kind] || "🔔"), text, el("time", "history-time", timeFmt.format(new Date(entry.created_at))));
        row.addEventListener("click", () => {
          closeDialog($("#dialog-history") as HTMLDialogElement);
          open(entry.workspace_id ?? "", entry.channel_id);
        });
        box.append(row);
      }
    }
  }

  // Charge les 100 dernières notifications.
  async function load(): Promise<void> {
    const { data, error } = await supabase
      .from("notification_log")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      available = false; // table absente ou accès refusé : la cloche reste vide, le reste de l'app fonctionne
      entries = [];
    } else {
      available = true;
      entries = (data ?? []) as LogEntry[];
    }
    renderBadge();
    if ($("#dialog-history").hasAttribute("open")) renderList();
  }

  // Une nouvelle notification arrive en temps réel (réservée à la personne par la sécurité de la base).
  function onRealtime(payload: { eventType?: string; new?: Partial<LogEntry> }): void {
    if (payload.eventType === "INSERT" && payload.new && payload.new.user_id === userId && payload.new.id) {
      if (!entries.some((e) => e.id === payload.new!.id)) entries = [payload.new as LogEntry, ...entries].slice(0, 100);
      available = true;
      renderBadge();
      if ($("#dialog-history").hasAttribute("open")) renderList();
    } else {
      void load(); // modification ou suppression : on relit
    }
  }

  // Ouvre la fenêtre, puis marque tout comme lu.
  function openPanel(): void {
    freshIds = new Set(entries.filter((e) => !e.read_at).map((e) => e.id));
    renderList();
    openDialog("#dialog-history");
    $("#history-title").focus();
    void markAllRead();
    void load();
  }

  async function markAllRead(): Promise<void> {
    if (!available || !unreadCount(entries)) return;
    const stamp = new Date().toISOString();
    entries = entries.map((e) => (e.read_at ? e : { ...e, read_at: stamp }));
    renderBadge();
    await supabase.from("notification_log").update({ read_at: stamp }).eq("user_id", userId).is("read_at", null);
  }

  async function clearAll(): Promise<void> {
    if (!entries.length || !window.confirm("Effacer tout l'historique des notifications ?")) return;
    const { error } = await supabase.from("notification_log").delete().eq("user_id", userId);
    if (error) {
      const note = $("#history-message");
      note.textContent = `Effacement impossible : ${error.message}`;
      note.hidden = false;
      return;
    }
    entries = [];
    freshIds = new Set();
    $("#history-message").hidden = true;
    renderBadge();
    renderList();
  }

  return { load, onRealtime, openPanel, clearAll, entries: () => entries };
}
