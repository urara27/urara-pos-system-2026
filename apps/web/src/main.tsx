import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import type { DeviceInfo } from '@pos/shared';
import { DeviceGate } from './components/DeviceGate';
import { keys, local, readJson } from './lib/storage';
import { AdminPage } from './routes/AdminPage';
import { CustomerPage } from './routes/CustomerPage';
import { KitchenPage } from './routes/KitchenPage';
import { PairingPage } from './routes/PairingPage';
import { PickupPage } from './routes/PickupPage';
import { RegisterPage } from './routes/RegisterPage';
import './styles.css';
import './screens.css';

/** `/` は登録済みならその端末の画面へ、未登録ならペアリング画面へ */
function Home() {
  const device = local.get(keys.deviceToken) ? readJson<DeviceInfo>(local, keys.device) : null;
  return <Navigate to={device ? `/${device.role}` : '/pairing'} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/pairing" element={<PairingPage />} />
        <Route path="/register" element={<DeviceGate role="register"><RegisterPage /></DeviceGate>} />
        <Route path="/kitchen" element={<DeviceGate role="kitchen"><KitchenPage /></DeviceGate>} />
        <Route path="/customer" element={<DeviceGate role="customer"><CustomerPage /></DeviceGate>} />
        <Route path="/pickup" element={<DeviceGate role="pickup"><PickupPage /></DeviceGate>} />
        <Route path="/admin/*" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
