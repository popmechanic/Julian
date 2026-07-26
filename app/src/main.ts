// app/src/main.ts — real application entry (replaces the scaffold-task placeholder).
import { mount } from 'svelte';
import App from './App.svelte';
import { streamDebug } from './lib/store';
import './app.css';

// spec §13: divergence diagnostics — hash + message count in one console call.
(window as unknown as { julianStream: typeof streamDebug }).julianStream = streamDebug;

mount(App, { target: document.getElementById('app')! });
