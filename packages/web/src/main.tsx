import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/standard.css';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { App } from './App';
import { registerServiceWorker } from './lib/offline';

registerServiceWorker();

createRoot(document.getElementById('root')!).render(<App />);
