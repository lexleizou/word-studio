// 栏宽拖动条：pointermove 改宽度 + clamp + localStorage 持久化
import { useRef } from 'react';
import { store } from '../store.js';

const CLAMP = { left: [180, 480], right: [280, 600] };

export default function Resizer({ side }) {
  const ref = useRef(null);

  const onPointerDown = (e) => {
    e.preventDefault();
    const el = ref.current;
    el.classList.add('active');
    el.setPointerCapture(e.pointerId);
    const key = side === 'left' ? 'leftW' : 'rightW';
    const startX = e.clientX;
    const startW = store.get(key);
    const [min, max] = CLAMP[side];

    const onMove = (ev) => {
      // 左栏：向右拖变宽；右栏：向左拖变宽
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
      store.set({ [key]: Math.min(max, Math.max(min, startW + delta)) });
    };
    const onUp = () => {
      el.classList.remove('active');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      localStorage.setItem('ws.' + key, String(store.get(key)));
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
  };

  return <div ref={ref} className="col-resizer app-chrome" onPointerDown={onPointerDown} />;
}
