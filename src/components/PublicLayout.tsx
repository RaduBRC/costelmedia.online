/**
 * Shell for the public marketing/legal route tree (/, /privacy, /terms) —
 * PublicNav + routed content + Footer, same "persistent shell, <Outlet/>
 * for the page" pattern as DashboardLayout.tsx uses for /admin/*.
 */
import { Outlet } from "react-router-dom";
import Footer from "./Footer.js";
import PublicNav from "./PublicNav.js";

export default function PublicLayout(): JSX.Element {
  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-slate-950">
      <PublicNav />
      <main className="flex-1">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
