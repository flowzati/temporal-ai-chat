import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// 挂載 React 應用程式
const container = document.getElementById('root');
if (!container) throw new Error('Root container missing');
const root = createRoot(container);
root.render(<App />);
