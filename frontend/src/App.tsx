import { Routes, Route, Navigate } from 'react-router-dom';
import DashboardLayout from './layouts/DashboardLayout';
import RequireAuth from './components/RequireAuth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Users from './pages/Users';
import Devices from './pages/Devices';
import DeviceGroups from './pages/DeviceGroups';
import Groups from './pages/Groups';
import Profiles from './pages/Profiles';
import Rulesets from './pages/Rulesets';
import Logs from './pages/Logs';
import Config from './pages/Config';
import Backups from './pages/Backups';
import TacacsSettings from './pages/TacacsSettings';
import Tools from './pages/Tools';
import Settings from './pages/Settings';
import ApiDocs from './pages/ApiDocs';
import DnsZones from './pages/DnsZones';
import DnsZone from './pages/DnsZone';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Full-screen standalone docs (outside the dashboard chrome) */}
      <Route path="/api-docs" element={<RequireAuth><ApiDocs /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><DashboardLayout /></RequireAuth>}>
        <Route index element={<Dashboard />} />
        <Route path="users" element={<Users />} />
        <Route path="devices" element={<Devices />} />
        <Route path="device-groups" element={<DeviceGroups />} />
        <Route path="groups" element={<Groups />} />
        <Route path="profiles" element={<Profiles />} />
        <Route path="rulesets" element={<Rulesets />} />
        <Route path="logs" element={<Logs />} />
        <Route path="config" element={<Config />} />
        <Route path="backups" element={<Backups />} />
        <Route path="tacacs-settings" element={<TacacsSettings />} />
        <Route path="tools" element={<Tools />} />
        <Route path="dns" element={<Navigate to="/dns/domains" replace />} />
        <Route path="dns/domains" element={<DnsZones kind="forward" />} />
        <Route path="dns/reverse" element={<DnsZones kind="reverse" />} />
        <Route path="dns/zone/:name" element={<DnsZone />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
