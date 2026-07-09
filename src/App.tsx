import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './lib/auth'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Inventory from './pages/Inventory'
import Bookings from './pages/Bookings'
import Sales from './pages/Sales'
import Buyers from './pages/Buyers'
import Expenses from './pages/Expenses'
import Partners from './pages/Partners'
import Activity from './pages/Activity'

const ImportExcel = lazy(() => import('./pages/ImportExcel'))

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            element={
              <ProtectedRoute>
                <Layout />
              </ProtectedRoute>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/bookings" element={<Bookings />} />
            <Route path="/sales" element={<Sales />} />
            <Route path="/buyers" element={<Buyers />} />
            <Route path="/expenses" element={<Expenses />} />
            <Route path="/partners" element={<Partners />} />
            <Route path="/activity" element={<Activity />} />
            <Route
              path="/import"
              element={
                <Suspense fallback={<p className="text-gray-500">Loading...</p>}>
                  <ImportExcel />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
