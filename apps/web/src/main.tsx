import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";
import { loadNextcloudTheme } from "./theme.ts";
import { primeLastView } from "./cache.ts";
import { DialogProvider, ToastProvider } from "./ui.tsx";
import { ContextMenuProvider } from "./ContextMenu.tsx";
import { installModalFocus } from "./modalFocus.ts";

performance.mark("ncmail:start");
installModalFocus();

// Start the requests the first screen needs right away (accounts, folders and the list of the view you left),
// in parallel with loading the app, instead of discovering them one after another after rendering.
primeLastView();

loadNextcloudTheme().finally(() => createRoot(document.getElementById("root")!).render(<ToastProvider><DialogProvider><ContextMenuProvider><App /></ContextMenuProvider></DialogProvider></ToastProvider>));
