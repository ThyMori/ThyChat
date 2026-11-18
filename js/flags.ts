// Drapeaux de livraison. Mettre UPDATE_PENDING à true tant qu'une action est attendue dans Supabase
// (SQL à rejouer, fonction à redéployer, secret à créer) ; repasser à false une fois « c'est déployé ».
export const UPDATE_PENDING = true;

// Affiche une petite pastille rouge « update en cours » dans un coin de l'écran quand le drapeau est levé.
export function showUpdatePending(): void {
  if (!UPDATE_PENDING) return; // rien à afficher quand aucune action n'est attendue
  const badge = document.createElement("div"); // crée la pastille
  badge.className = "update-pending"; // style défini dans css/style.css
  badge.textContent = "update en cours"; // texte : jamais d'innerHTML
  badge.setAttribute("role", "status"); // lue par les lecteurs d'écran
  document.body.append(badge); // l'ajoute à la page
}
