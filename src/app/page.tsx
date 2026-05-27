'use client';

import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import * as XLSX from 'xlsx';
import { 
  Send, 
  Users, 
  Smartphone, 
  History, 
  Play, 
  Pause, 
  Square, 
  Plus, 
  Trash2, 
  Upload, 
  AlertCircle, 
  CheckCircle, 
  Clock, 
  Loader2, 
  FileText, 
  RefreshCw, 
  Layers, 
  Info,
  ExternalLink
} from 'lucide-react';
import confetti from 'canvas-confetti';

// Backend API URL
const API_URL = 'https://bulkmessaging-backend-production.up.railway.app';

interface Session {
  id: string;
  name: string;
  phoneNumber: string;
  status: 'DISCONNECTED' | 'CONNECTING' | 'QR_READY' | 'CONNECTED';
  qrCode?: string;
}

interface Campaign {
  id: string;
  name: string;
  sessionId: string;
  messageMode: 'common' | 'personalized';
  templates: string[];
  status: 'scheduled' | 'running' | 'paused' | 'stopped' | 'completed';
  scheduledAt?: string;
  batchSize: number;
  batchCooldown: number;
  minDelay: number;
  maxDelay: number;
  media?: {
    filename: string;
    originalName: string;
    mimeType: string;
  };
  totalContacts: number;
  createdAt: string;
  cooldownUntil?: string;
  stats?: {
    total: number;
    sent: number;
    failed: number;
    pending: number;
  };
}

interface Message {
  id: string;
  campaignId: string;
  phoneNumber: string;
  name: string;
  messageContent: string;
  status: 'pending' | 'sent' | 'failed';
  error?: string;
  sentAt?: string;
}

interface LogEntry {
  id: string;
  timestamp: string;
  campaignId: string;
  level: 'info' | 'success' | 'error';
  message: string;
}

export default function Home() {
  // Navigation & Tabs
  const [activeTab, setActiveTab] = useState<'dashboard' | 'create' | 'sessions'>('dashboard');

  // WebSocket Connection
  const [socketConnected, setSocketConnected] = useState(false);
  const socketRef = useRef<any>(null);

  // Lists and Selections
  const [sessions, setSessions] = useState<Session[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string>('');
  const [campaignMessages, setCampaignMessages] = useState<Message[]>([]);
  const [campaignLogs, setCampaignLogs] = useState<LogEntry[]>([]);

  // Loading States
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loadingLogsMessages, setLoadingLogsMessages] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [isSubmittingCampaign, setIsSubmittingCampaign] = useState(false);

  // System Time State (fixes hydration mismatch)
  const [systemTime, setSystemTime] = useState<string>('');

  // Form inputs for New Session
  const [newSessionName, setNewSessionName] = useState('');

  // System Time Updater (Runs once on mount)
  useEffect(() => {
    setSystemTime(new Date().toLocaleTimeString());
    const interval = setInterval(() => {
      setSystemTime(new Date().toLocaleTimeString());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Form inputs for New Campaign
  const [campaignName, setCampaignName] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [messageMode, setMessageMode] = useState<'common' | 'personalized'>('common');
  const [templates, setTemplates] = useState<string[]>(['Hello {name}, welcome to our service.']);
  const [importOption, setImportOption] = useState<'manual' | 'file'>('manual');
  const [manualNumbers, setManualNumbers] = useState('');
  const [parsedContacts, setParsedContacts] = useState<{ name: string; phone: string; customFields: Record<string, string> }[]>([]);
  const [parsedFileStats, setParsedFileStats] = useState<string>('');
  const [batchSize, setBatchSize] = useState<number>(200);
  const [batchCooldown, setBatchCooldown] = useState<number>(300); // 5 minutes
  const [minDelay, setMinDelay] = useState<number>(20);
  const [maxDelay, setMaxDelay] = useState<number>(45);
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduledDate, setScheduledDate] = useState('');
  const [mediaFile, setMediaFile] = useState<File | null>(null);

  // Scroll ref for logs terminal
  const logTerminalEndRef = useRef<HTMLDivElement>(null);

  // 1. Initial Load
  useEffect(() => {
    fetchSessions();
    fetchCampaigns();

    // Setup Socket
    socketRef.current = io(API_URL);

    socketRef.current.on('connect', () => {
      setSocketConnected(true);
    });

    socketRef.current.on('disconnect', () => {
      setSocketConnected(false);
    });

    socketRef.current.on('session_update', (updatedSession: Session) => {
      setSessions(prev => {
        const idx = prev.findIndex(s => s.id === updatedSession.id);
        if (idx !== -1) {
          const newSessions = [...prev];
          newSessions[idx] = updatedSession;
          return newSessions;
        } else {
          return [...prev, updatedSession];
        }
      });
    });

    socketRef.current.on('session_deleted', ({ id }: { id: string }) => {
      setSessions(prev => prev.filter(s => s.id !== id));
    });

    socketRef.current.on('campaign_update', (updatedCampaign: Campaign) => {
      setCampaigns(prev => {
        const idx = prev.findIndex(c => c.id === updatedCampaign.id);
        if (idx !== -1) {
          const newCamps = [...prev];
          
          // Preserve stats if update doesn't have them
          const oldCamp = prev[idx];
          newCamps[idx] = {
            ...updatedCampaign,
            stats: updatedCampaign.stats || oldCamp.stats
          };
          return newCamps;
        }
        return prev;
      });

      // If this campaign is the currently active/selected one, refresh stats/logs
      if (selectedCampaignId === updatedCampaign.id) {
        refreshSelectedCampaignDetails(updatedCampaign.id);

        // Confetti when campaign transitions to completed
        if (updatedCampaign.status === 'completed') {
          confetti({
            particleCount: 150,
            spread: 80,
            origin: { y: 0.6 }
          });
        }
      }
    });

    socketRef.current.on('message_status', (data: { messageId: string; status: 'sent' | 'failed'; campaignId: string }) => {
      // If we are viewing the campaign, update the messages list dynamically
      if (selectedCampaignId === data.campaignId) {
        setCampaignMessages(prev => {
          return prev.map(m => {
            if (m.id === data.messageId) {
              return { ...m, status: data.status, sentAt: new Date().toISOString() };
            }
            return m;
          });
        });
        // We also need to refresh campaign stats and fetch new logs
        refreshSelectedCampaignDetails(data.campaignId);
      }
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, [selectedCampaignId]);

  // Scroll terminal logs to bottom on new logs
  useEffect(() => {
    if (logTerminalEndRef.current) {
      logTerminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [campaignLogs]);

  // Fetch all campaigns and select first one if dashboard is open
  const fetchCampaigns = async (selectFirst = false) => {
    setLoadingCampaigns(true);
    try {
      const res = await fetch(`${API_URL}/api/campaigns`);
      const data = await res.json();
      setCampaigns(data);
      if (data.length > 0 && (selectFirst || !selectedCampaignId)) {
        setSelectedCampaignId(data[0].id);
        fetchCampaignDetails(data[0].id);
      }
    } catch (err) {
      console.error('Error fetching campaigns:', err);
    } finally {
      setLoadingCampaigns(false);
    }
  };

  const fetchSessions = async () => {
    setLoadingSessions(true);
    try {
      const res = await fetch(`${API_URL}/api/sessions`);
      const data = await res.json();
      setSessions(data);
      if (data.length > 0 && !selectedSessionId) {
        setSelectedSessionId(data[0].id);
      }
    } catch (err) {
      console.error('Error fetching sessions:', err);
    } finally {
      setLoadingSessions(false);
    }
  };

  // Get log details + messages
  const fetchCampaignDetails = async (campaignId: string) => {
    if (!campaignId) return;
    setLoadingLogsMessages(true);
    try {
      // Fetch messages
      const msgRes = await fetch(`${API_URL}/api/campaigns/${campaignId}/messages`);
      const messages = await msgRes.json();
      setCampaignMessages(messages);

      // Fetch logs
      const logRes = await fetch(`${API_URL}/api/campaigns/${campaignId}/logs`);
      const logs = await logRes.json();
      setCampaignLogs(logs);
    } catch (err) {
      console.error('Error fetching campaign details:', err);
    } finally {
      setLoadingLogsMessages(false);
    }
  };

  const refreshSelectedCampaignDetails = async (campaignId: string) => {
    try {
      // Fetch logs
      const logRes = await fetch(`${API_URL}/api/campaigns/${campaignId}/logs`);
      const logs = await logRes.json();
      setCampaignLogs(logs);

      // Reload campaign stats in list
      const res = await fetch(`${API_URL}/api/campaigns`);
      const data = await res.json();
      setCampaigns(data);
    } catch (err) {
      console.error('Error auto-refreshing campaign:', err);
    }
  };

  const handleCampaignSelect = (id: string) => {
    setSelectedCampaignId(id);
    fetchCampaignDetails(id);
  };

  // --- SESSIONS TAB ACTIONS ---
  const handleCreateSession = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSessionName.trim()) return;
    setIsCreatingSession(true);
    try {
      const res = await fetch(`${API_URL}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSessionName })
      });
      const data = await res.json();
      setNewSessionName('');
      fetchSessions();
    } catch (err) {
      console.error('Error creating session:', err);
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (!confirm('Are you sure you want to delete this session and clear its credentials?')) return;
    try {
      await fetch(`${API_URL}/api/sessions/${id}`, { method: 'DELETE' });
      fetchSessions();
    } catch (err) {
      console.error('Error deleting session:', err);
    }
  };

  const handleReconnectSession = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/sessions/${id}/restart`, { method: 'POST' });
    } catch (err) {
      console.error('Error restarting session:', err);
    }
  };

  // --- CAMPAIGN ACTIONS (Pause, Resume, Stop) ---
  const handleCampaignAction = async (action: 'pause' | 'resume' | 'stop', campaignId: string) => {
    try {
      await fetch(`${API_URL}/api/campaigns/${campaignId}/${action}`, { method: 'POST' });
      // Reload campaigns
      fetchCampaigns();
    } catch (err) {
      console.error(`Error performing campaign action ${action}:`, err);
    }
  };

  // --- CONTACT IMPORT PARSERS ---
  const handleManualNumbersChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setManualNumbers(val);

    // Format: name,phone or just phone (one per line)
    const lines = val.split('\n');
    const contacts: typeof parsedContacts = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const parts = line.split(',');
      if (parts.length >= 2) {
        contacts.push({
          name: parts[0].trim(),
          phone: parts[1].trim(),
          customFields: {}
        });
      } else {
        contacts.push({
          name: '',
          phone: parts[0].trim(),
          customFields: {}
        });
      }
    }
    setParsedContacts(contacts);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const fileReader = new FileReader();

    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv')) {
      fileReader.onload = (event) => {
        try {
          const binaryStr = event.target?.result;
          const workbook = XLSX.read(binaryStr, { type: 'binary' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const rawData = XLSX.utils.sheet_to_json<Record<string, any>>(worksheet);

          const contacts: typeof parsedContacts = [];
          
          rawData.forEach((row) => {
            // Find key that contains "phone", "number", or "mobile" case-insensitive
            const phoneKey = Object.keys(row).find(key => 
              /phone|number|mobile/i.test(key)
            );
            // Find key that contains "name" case-insensitive
            const nameKey = Object.keys(row).find(key => 
              /name/i.test(key)
            );

            const phone = phoneKey ? row[phoneKey]?.toString().trim() : '';
            const name = nameKey ? row[nameKey]?.toString().trim() : '';

            // Extract custom fields (all columns other than name and phone)
            const customFields: Record<string, string> = {};
            Object.keys(row).forEach((key) => {
              if (key !== phoneKey && key !== nameKey) {
                customFields[key] = row[key]?.toString().trim() || '';
              }
            });

            if (phone) {
              contacts.push({ name, phone, customFields });
            }
          });

          setParsedContacts(contacts);
          setParsedFileStats(`Successfully parsed ${contacts.length} rows from file ${file.name}`);
        } catch (err: any) {
          console.error(err);
          setParsedFileStats(`Error parsing Excel/CSV file: ${err.message}`);
        }
      };
      fileReader.readAsBinaryString(file);
    } else if (file.name.endsWith('.txt') || file.name.endsWith('.doc') || file.name.endsWith('.docx')) {
      // Treat doc and docx as plain text extracts for simple matching (Node docx parser is too heavy for browser, simple text reader fallback)
      fileReader.onload = (event) => {
        try {
          const text = event.target?.result as string;
          const lines = text.split('\n');
          const contacts: typeof parsedContacts = [];

          lines.forEach((line) => {
            if (!line.trim()) return;
            const parts = line.split(/[,\t]/); // split by comma or tab
            if (parts.length >= 2) {
              contacts.push({
                name: parts[0].trim(),
                phone: parts[1].trim(),
                customFields: {}
              });
            } else {
              // try to extract anything that looks like phone digits
              const cleanDigits = parts[0].replace(/[^0-9+]/g, '');
              if (cleanDigits.length >= 8) {
                contacts.push({
                  name: '',
                  phone: cleanDigits,
                  customFields: {}
                });
              }
            }
          });

          setParsedContacts(contacts);
          setParsedFileStats(`Parsed ${contacts.length} lines from file ${file.name}`);
        } catch (err: any) {
          setParsedFileStats(`Error reading text file: ${err.message}`);
        }
      };
      fileReader.readAsText(file);
    } else {
      setParsedFileStats('Unsupported file format. Please upload Excel, CSV, or Text.');
    }
  };

  // --- TEMPLATE EDIT ACTIONS ---
  const handleAddTemplateVariation = () => {
    setTemplates([...templates, '']);
  };

  const handleTemplateChange = (index: number, val: string) => {
    const next = [...templates];
    next[index] = val;
    setTemplates(next);
  };

  const handleRemoveTemplateVariation = (index: number) => {
    if (templates.length === 1) return;
    const next = templates.filter((_, i) => i !== index);
    setTemplates(next);
  };

  // --- SUBMIT CAMPAIGN ---
  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!campaignName.trim()) {
      alert('Please enter a campaign name');
      return;
    }
    if (!selectedSessionId) {
      alert('Please select a WhatsApp session');
      return;
    }
    if (parsedContacts.length === 0) {
      alert('Please import/enter at least one contact');
      return;
    }

    const filteredTemplates = templates.filter(t => t.trim());
    if (filteredTemplates.length === 0) {
      alert('Please add at least one message template');
      return;
    }

    setIsSubmittingCampaign(true);

    try {
      const formData = new FormData();
      formData.append('name', campaignName);
      formData.append('sessionId', selectedSessionId);
      formData.append('messageMode', messageMode);
      formData.append('templatesJson', JSON.stringify(filteredTemplates));
      formData.append('contactsJson', JSON.stringify(parsedContacts));
      formData.append('batchSize', batchSize.toString());
      formData.append('batchCooldown', batchCooldown.toString());
      formData.append('minDelay', minDelay.toString());
      formData.append('maxDelay', maxDelay.toString());

      if (isScheduled && scheduledDate) {
        formData.append('scheduledAt', new Date(scheduledDate).toISOString());
      }

      if (mediaFile) {
        formData.append('mediaFile', mediaFile);
      }

      const res = await fetch(`${API_URL}/api/campaigns`, {
        method: 'POST',
        body: formData // Using multipart/form-data for file uploads
      });

      if (!res.ok) {
        let errMsg = 'Failed to create campaign';
        try {
          const errData = await res.json();
          errMsg = errData.error || errMsg;
        } catch (e) {
          try {
            const text = await res.text();
            if (text) errMsg = text;
          } catch {}
        }
        throw new Error(errMsg);
      }

      const resData = await res.json();
      
      // Reset Form
      setCampaignName('');
      setTemplates(['Hello {name}, welcome to our service.']);
      setParsedContacts([]);
      setParsedFileStats('');
      setManualNumbers('');
      setMediaFile(null);
      setIsScheduled(false);
      setScheduledDate('');

      // Refresh campaigns and auto-select new campaign
      await fetchCampaigns(true);
      
      // Navigate to dashboard tab
      setActiveTab('dashboard');
      
      // Select the new campaign ID
      setSelectedCampaignId(resData.campaign.id);
      fetchCampaignDetails(resData.campaign.id);
      
    } catch (err: any) {
      alert(`Error creating campaign: ${err.message}`);
    } finally {
      setIsSubmittingCampaign(false);
    }
  };

  // Helper stats calculation
  const getSelectedCampaign = () => {
    return campaigns.find(c => c.id === selectedCampaignId);
  };

  const selectedCampaign = getSelectedCampaign();

  return (
    <div className="flex-1 flex flex-col bg-slate-50 bg-grid min-h-screen">
      {/* Decorative top ambient bar */}
      <div className="w-full h-1 bg-gradient-to-r from-emerald-400 via-teal-500 to-emerald-600 animate-shimmer" style={{ backgroundSize: '200% 100%' }}></div>

      {/* HEADER SECTION */}
      <header className="bg-white border-b border-slate-200 py-4 px-6 md:px-12 flex flex-col md:flex-row justify-between items-center gap-4 shadow-xs sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500 text-white p-2.5 rounded-xl shadow-md shadow-emerald-200 animate-pulse-ring">
            <Send className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-slate-900 leading-none">BulkFlow</h1>
            <span className="text-xs text-slate-500 font-semibold uppercase tracking-wider">WhatsApp Delivery Suite</span>
          </div>
        </div>

        {/* Server & WebSocket Connection Badge */}
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold shadow-2xs ${
            socketConnected 
              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
              : 'bg-rose-50 text-rose-700 border border-rose-200'
          }`}>
            <span className={`w-2 h-2 rounded-full ${socketConnected ? 'bg-emerald-500' : 'bg-rose-500 animate-ping'}`}></span>
            {socketConnected ? 'Connected to Socket' : 'Connecting to Socket...'}
          </div>
          
          <button 
            onClick={() => { fetchSessions(); fetchCampaigns(); }} 
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200 transition-colors"
            title="Refresh Data"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-8 flex flex-col gap-6">
        
        {/* TAB BUTTONS - Crisp White background with Black Text and Emerald Highlights */}
        <div className="flex justify-between items-center border-b border-slate-200 pb-2">
          <div className="flex bg-slate-100 p-1.5 rounded-xl gap-1.5">
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold tracking-wide transition-all ${
                activeTab === 'dashboard'
                  ? 'bg-white text-slate-900 shadow-md font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <History className="w-4 h-4" />
              Live Dashboard
            </button>
            <button
              onClick={() => setActiveTab('create')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold tracking-wide transition-all ${
                activeTab === 'create'
                  ? 'bg-white text-slate-900 shadow-md font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Plus className="w-4 h-4" />
              Start Campaign
            </button>
            <button
              onClick={() => setActiveTab('sessions')}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold tracking-wide transition-all ${
                activeTab === 'sessions'
                  ? 'bg-white text-slate-900 shadow-md font-extrabold'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <Smartphone className="w-4 h-4" />
              WhatsApp Sessions
              {sessions.filter(s => s.status === 'CONNECTED').length > 0 && (
                <span className="bg-emerald-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                  {sessions.filter(s => s.status === 'CONNECTED').length}
                </span>
              )}
            </button>
          </div>

          <div className="hidden sm:flex text-xs text-slate-400 font-medium">
            System time: {systemTime || 'Loading...'}
          </div>
        </div>

        {/* ============================================================== */}
        {/* 1. LIVE DASHBOARD TAB */}
        {/* ============================================================== */}
        {activeTab === 'dashboard' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in">
            {/* Left side: Campaigns list */}
            <div className="lg:col-span-1 flex flex-col gap-4">
              <div className="bg-white p-5 rounded-2xl border border-slate-200 shadow-xs animated-card-border">
                <h2 className="text-lg font-black text-slate-900 mb-3 uppercase tracking-wide border-b border-slate-100 pb-2">Campaigns</h2>
                
                {loadingCampaigns ? (
                  <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
                    <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                    <span className="text-sm font-medium">Loading campaigns...</span>
                  </div>
                ) : campaigns.length === 0 ? (
                  <div className="text-center py-12 px-4 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                    <History className="w-8 h-8 mx-auto text-slate-350 mb-2" />
                    <h3 className="text-sm font-bold text-slate-800">No campaigns found</h3>
                    <p className="text-xs text-slate-500 mt-1 max-w-[200px] mx-auto">Create a campaign to start broadcasting bulk messages.</p>
                    <button 
                      onClick={() => setActiveTab('create')}
                      className="mt-4 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg transition-colors shadow-sm"
                    >
                      Create First Campaign
                    </button>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 max-h-[500px] overflow-y-auto pr-1 custom-scrollbar">
                    {campaigns.map(camp => {
                      const isActive = camp.id === selectedCampaignId;
                      const stats = camp.stats || { total: 0, sent: 0, failed: 0, pending: 0 };
                      const progress = stats.total > 0 ? Math.round(((stats.sent + stats.failed) / stats.total) * 100) : 0;
                      
                      return (
                        <div
                          key={camp.id}
                          onClick={() => handleCampaignSelect(camp.id)}
                          className={`p-3.5 rounded-xl border cursor-pointer transition-all ${
                            isActive 
                              ? 'bg-slate-900 border-slate-900 text-white shadow-md' 
                              : 'bg-white border-slate-200 hover:border-slate-400 hover:shadow-2xs text-slate-900'
                          }`}
                        >
                          <div className="flex justify-between items-start gap-2 mb-1.5">
                            <h3 className="font-extrabold text-sm truncate max-w-[150px]">{camp.name}</h3>
                            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                              camp.status === 'running' 
                                ? 'bg-emerald-500 text-white' 
                                : camp.status === 'paused' 
                                ? 'bg-amber-500 text-white' 
                                : camp.status === 'completed' 
                                ? 'bg-blue-600 text-white' 
                                : camp.status === 'scheduled'
                                ? 'bg-violet-600 text-white'
                                : 'bg-rose-500 text-white'
                            }`}>
                              {camp.status}
                            </span>
                          </div>
                          
                          <div className="flex justify-between text-[11px] font-semibold mb-2 opacity-80">
                            <span>{new Date(camp.createdAt).toLocaleDateString()}</span>
                            <span>{stats.sent}/{stats.total} Sent</span>
                          </div>

                          {/* Progress Line */}
                          <div className="w-full bg-slate-200/40 rounded-full h-1.5 overflow-hidden">
                            <div 
                              className={`h-full transition-all duration-500 ${isActive ? 'bg-emerald-400' : 'bg-emerald-500'}`} 
                              style={{ width: `${progress}%` }}
                            ></div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right side: Selected Campaign Details */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              {selectedCampaign ? (
                <>
                  {/* Stats Cards */}
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs animated-card-border">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 border-b border-slate-100 pb-4 mb-4">
                      <div>
                        <h2 className="text-xl font-black text-slate-900">{selectedCampaign.name}</h2>
                        <p className="text-xs font-semibold text-slate-500 mt-0.5">
                          Session: <span className="text-slate-800 font-bold">{(sessions.find(s => s.id === selectedCampaign.sessionId)?.name) || selectedCampaign.sessionId}</span> • Created: {new Date(selectedCampaign.createdAt).toLocaleString()}
                        </p>
                      </div>

                      {/* Controls */}
                      <div className="flex items-center gap-2">
                        {selectedCampaign.status === 'running' && (
                          <button
                            onClick={() => handleCampaignAction('pause', selectedCampaign.id)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-white text-xs font-bold rounded-lg transition-colors shadow-xs"
                          >
                            <Pause className="w-3.5 h-3.5" /> Pause
                          </button>
                        )}
                        {(selectedCampaign.status === 'paused' || selectedCampaign.status === 'scheduled') && (
                          <button
                            onClick={() => handleCampaignAction('resume', selectedCampaign.id)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg transition-colors shadow-xs"
                          >
                            <Play className="w-3.5 h-3.5" /> Resume
                          </button>
                        )}
                        {['running', 'paused', 'scheduled'].includes(selectedCampaign.status) && (
                          <button
                            onClick={() => handleCampaignAction('stop', selectedCampaign.id)}
                            className="flex items-center gap-1 px-3 py-1.5 bg-rose-500 hover:bg-rose-600 text-white text-xs font-bold rounded-lg transition-colors shadow-xs"
                          >
                            <Square className="w-3.5 h-3.5" /> Stop
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Stats Counter Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                      {/* Total */}
                      <div className="bg-slate-50 border border-slate-200/80 p-4 rounded-xl text-center">
                        <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">Total</div>
                        <div className="text-2xl font-black text-slate-900">{selectedCampaign.stats?.total || 0}</div>
                      </div>
                      {/* Sent */}
                      <div className="bg-emerald-50 border border-emerald-100 p-4 rounded-xl text-center">
                        <div className="text-xs text-emerald-600 font-bold uppercase tracking-wider mb-1">Sent</div>
                        <div className="text-2xl font-black text-emerald-700">{selectedCampaign.stats?.sent || 0}</div>
                      </div>
                      {/* Pending */}
                      <div className="bg-slate-100 border border-slate-200 p-4 rounded-xl text-center">
                        <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">Pending</div>
                        <div className="text-2xl font-black text-slate-600">{selectedCampaign.stats?.pending || 0}</div>
                      </div>
                      {/* Failed */}
                      <div className="bg-rose-50 border border-rose-100 p-4 rounded-xl text-center">
                        <div className="text-xs text-rose-600 font-bold uppercase tracking-wider mb-1">Failed</div>
                        <div className="text-2xl font-black text-rose-700">{selectedCampaign.stats?.failed || 0}</div>
                      </div>
                    </div>

                    {/* Live Progress Bar with Animation */}
                    <div className="mt-6">
                      <div className="flex justify-between text-xs font-bold text-slate-800 mb-1.5">
                        <span>Delivery Progress</span>
                        <span>
                          {selectedCampaign.stats && selectedCampaign.stats.total > 0 
                            ? Math.round(((selectedCampaign.stats.sent + selectedCampaign.stats.failed) / selectedCampaign.stats.total) * 100) 
                            : 0}%
                        </span>
                      </div>
                      
                      <div className="w-full bg-slate-100 border border-slate-200 rounded-full h-3.5 overflow-hidden">
                        <div 
                          className="h-full bg-gradient-to-r from-emerald-400 to-emerald-500 transition-all duration-500 relative" 
                          style={{ 
                            width: `${
                              selectedCampaign.stats && selectedCampaign.stats.total > 0 
                                ? ((selectedCampaign.stats.sent + selectedCampaign.stats.failed) / selectedCampaign.stats.total) * 100 
                                : 0
                            }%` 
                          }}
                        >
                          {selectedCampaign.status === 'running' && (
                            <div className="absolute inset-0 bg-white/20 animate-shimmer" style={{ backgroundSize: '200% 100%', width: '100%' }}></div>
                          )}
                        </div>
                      </div>

                      {/* Cooldown notification */}
                      {selectedCampaign.cooldownUntil && (
                        <div className="mt-3 flex items-center gap-2 p-3 bg-amber-50 text-amber-800 border border-amber-250 rounded-xl text-xs font-semibold animate-pulse">
                          <Clock className="w-4 h-4 text-amber-500 flex-shrink-0" />
                          <span>
                            Batch Cooldown active. Resuming next batch at {new Date(selectedCampaign.cooldownUntil).toLocaleTimeString()}.
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Real-time Logs Terminal (monospaced logs) */}
                  <div className="bg-slate-900 text-slate-100 rounded-2xl p-5 shadow-lg border border-slate-800 relative flex flex-col h-[280px]">
                    <div className="flex justify-between items-center border-b border-slate-800 pb-2 mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full animate-ping"></div>
                        <span className="text-xs font-mono font-bold tracking-wider text-emerald-400">LIVE DELIVERY LOGS</span>
                      </div>
                      <div className="flex gap-1.5">
                        <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                        <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                        <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                      </div>
                    </div>

                    <div className="flex-1 overflow-y-auto custom-scrollbar font-mono text-[11px] space-y-1.5 text-slate-350 pr-1">
                      {loadingLogsMessages ? (
                        <div className="text-center py-12 text-slate-500">Loading campaign logs...</div>
                      ) : campaignLogs.length === 0 ? (
                        <div className="text-center py-12 text-slate-650">[Waiting for logs...]</div>
                      ) : (
                        campaignLogs.map(log => {
                          const date = new Date(log.timestamp).toLocaleTimeString();
                          let color = 'text-slate-400';
                          if (log.level === 'success') color = 'text-emerald-400';
                          if (log.level === 'error') color = 'text-rose-400';
                          
                          return (
                            <div key={log.id} className="flex gap-2 hover:bg-slate-800/40 p-0.5 rounded transition-all">
                              <span className="text-slate-500 font-bold flex-shrink-0">[{date}]</span>
                              <span className={`${color}`}>{log.message}</span>
                            </div>
                          );
                        })
                      )}
                      <div ref={logTerminalEndRef}></div>
                    </div>
                  </div>

                  {/* Messages Queue Table */}
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs animated-card-border">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-lg font-black text-slate-900 uppercase tracking-wide">Queue Details</h3>
                      <span className="text-xs text-slate-500 font-bold bg-slate-100 px-2.5 py-1 rounded-full">
                        {campaignMessages.length} total recipients
                      </span>
                    </div>

                    <div className="overflow-x-auto max-h-[300px] custom-scrollbar border border-slate-100 rounded-xl">
                      <table className="w-full text-left text-xs">
                        <thead className="bg-slate-50 text-slate-700 border-b border-slate-100 font-bold">
                          <tr>
                            <th className="p-3.5">Name</th>
                            <th className="p-3.5">Phone Number</th>
                            <th className="p-3.5">Message Snippet</th>
                            <th className="p-3.5">Status</th>
                            <th className="p-3.5">Time / Error</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {loadingLogsMessages ? (
                            <tr>
                              <td colSpan={5} className="text-center p-8 text-slate-400">Loading messages table...</td>
                            </tr>
                          ) : campaignMessages.length === 0 ? (
                            <tr>
                              <td colSpan={5} className="text-center p-8 text-slate-400">No contacts in this campaign queue.</td>
                            </tr>
                          ) : (
                            campaignMessages.map(msg => (
                              <tr key={msg.id} className="hover:bg-slate-50/50 transition-colors">
                                <td className="p-3.5 font-extrabold text-slate-900">{msg.name || <span className="text-slate-400 italic">No Name</span>}</td>
                                <td className="p-3.5 font-mono text-slate-600">+{msg.phoneNumber}</td>
                                <td className="p-3.5 text-slate-500 max-w-[200px] truncate" title={msg.messageContent}>{msg.messageContent}</td>
                                <td className="p-3.5">
                                  <span className={`px-2 py-0.5 rounded-full font-bold text-[10px] uppercase ${
                                    msg.status === 'sent' 
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-100' 
                                      : msg.status === 'failed' 
                                      ? 'bg-rose-50 text-rose-700 border border-rose-100' 
                                      : 'bg-slate-50 text-slate-500 border border-slate-200'
                                  }`}>
                                    {msg.status}
                                  </span>
                                </td>
                                <td className="p-3.5 text-slate-500 max-w-[180px] truncate">
                                  {msg.status === 'sent' && msg.sentAt && new Date(msg.sentAt).toLocaleTimeString()}
                                  {msg.status === 'failed' && <span className="text-rose-500 font-semibold" title={msg.error}>{msg.error || 'Failed'}</span>}
                                  {msg.status === 'pending' && <span className="text-slate-400">Queued</span>}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              ) : (
                <div className="bg-white py-16 px-6 border border-slate-200 rounded-2xl text-center shadow-xs flex flex-col justify-center items-center gap-2">
                  <Layers className="w-12 h-12 text-slate-300 animate-pulse" />
                  <h3 className="text-lg font-black text-slate-900 mt-2">No Campaign Selected</h3>
                  <p className="text-slate-500 max-w-sm text-sm">Select a campaign from the sidebar or start a new message campaign to view live progress metrics here.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* 2. CREATE CAMPAIGN TAB */}
        {/* ============================================================== */}
        {activeTab === 'create' && (
          <form onSubmit={handleCreateCampaign} className="bg-white p-6 md:p-8 rounded-2xl border border-slate-200 shadow-xs max-w-4xl mx-auto flex flex-col gap-6 animate-slide-up animated-card-border">
            
            {/* Header info */}
            <div className="border-b border-slate-100 pb-4">
              <h2 className="text-xl font-black text-slate-900 uppercase tracking-wide">Configure Campaign</h2>
              <p className="text-slate-500 text-xs mt-1">Configure your bulk campaign settings safely. Duplicates are auto-deducted and numbers validated before sending.</p>
            </div>

            {/* Campaign info section */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Campaign name */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-slate-900 uppercase">Campaign Name</label>
                <input 
                  type="text" 
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g. June Product Launch"
                  className="px-4 py-2.5 bg-slate-50 border border-slate-200 hover:border-slate-350 focus:border-emerald-500 focus:bg-white rounded-xl text-sm font-semibold outline-none transition-all"
                />
              </div>

              {/* Session ID selection */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-slate-900 uppercase">WhatsApp Sender Session</label>
                {sessions.length === 0 ? (
                  <div className="text-xs text-rose-500 font-semibold p-3 bg-rose-50 border border-rose-100 rounded-xl flex items-center justify-between">
                    <span>No active WhatsApp session found. Please link a device first.</span>
                    <button 
                      type="button" 
                      onClick={() => setActiveTab('sessions')}
                      className="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded font-bold transition-all"
                    >
                      Go to Sessions
                    </button>
                  </div>
                ) : (
                  <select 
                    value={selectedSessionId}
                    onChange={(e) => setSelectedSessionId(e.target.value)}
                    className="px-4 py-2.5 bg-slate-50 border border-slate-200 hover:border-slate-350 focus:border-emerald-500 focus:bg-white rounded-xl text-sm font-semibold outline-none transition-all"
                  >
                    <option value="" disabled>-- Select Session --</option>
                    {sessions.map(s => (
                      <option key={s.id} value={s.id} disabled={s.status !== 'CONNECTED'}>
                        {s.name} ({s.status === 'CONNECTED' ? 'CONNECTED' : `Offline - ${s.status}`})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>

            <div className="border-t border-slate-100 pt-4"></div>

            {/* CONTACT IMPORT SECTION */}
            <div className="flex flex-col gap-3">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <label className="text-xs font-bold text-slate-900 uppercase">1. Import Contacts</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setImportOption('manual'); setParsedContacts([]); setParsedFileStats(''); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      importOption === 'manual' 
                        ? 'bg-slate-900 text-white' 
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200'
                    }`}
                  >
                    Option A: Manual Numbers
                  </button>
                  <button
                    type="button"
                    onClick={() => { setImportOption('file'); setParsedContacts([]); setParsedFileStats(''); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      importOption === 'file' 
                        ? 'bg-slate-900 text-white' 
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200'
                    }`}
                  >
                    Option B: Import File (.xlsx, .csv, .txt)
                  </button>
                </div>
              </div>

              {/* Option A: Manual Entry */}
              {importOption === 'manual' && (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    rows={4}
                    value={manualNumbers}
                    onChange={handleManualNumbersChange}
                    placeholder="Enter phone numbers, one per line. Formats allowed:&#10;+919876543210&#10;Rahul, +919123456789 (Name, Phone)"
                    className="w-full p-4 bg-slate-50 border border-slate-200 hover:border-slate-350 focus:border-emerald-500 focus:bg-white rounded-xl text-sm font-semibold font-mono outline-none transition-all"
                  ></textarea>
                  <span className="text-[11px] text-slate-400 font-semibold leading-relaxed">
                    * Make sure to prefix numbers with country codes (e.g. 91 for India, 1 for USA).
                  </span>
                </div>
              )}

              {/* Option B: File Upload */}
              {importOption === 'file' && (
                <div className="border-2 border-dashed border-slate-200 hover:border-slate-350 bg-slate-50 hover:bg-slate-50/50 rounded-2xl p-6 text-center transition-all relative flex flex-col items-center">
                  <input 
                    type="file" 
                    accept=".xlsx,.xls,.csv,.txt"
                    onChange={handleFileUpload}
                    className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                  />
                  <Upload className="w-8 h-8 text-slate-400 mb-2" />
                  <span className="text-xs font-bold text-slate-800">Drag and drop file here, or click to upload</span>
                  <span className="text-[10px] text-slate-400 mt-1">Supports Excel (.xlsx, .xls), CSV (.csv), or Text documents (.txt)</span>
                  
                  {parsedFileStats && (
                    <div className="mt-4 p-2 px-4 rounded-lg bg-emerald-50 border border-emerald-100 text-xs text-emerald-800 font-semibold flex items-center gap-1.5">
                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                      {parsedFileStats}
                    </div>
                  )}
                </div>
              )}

              {/* Contacts preview summary */}
              {parsedContacts.length > 0 && (
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col gap-2">
                  <div className="flex justify-between items-center text-xs font-bold text-slate-800">
                    <span>Parsed Recipients Queue</span>
                    <span>{parsedContacts.length} numbers loaded</span>
                  </div>
                  <div className="max-h-[100px] overflow-y-auto pr-1 custom-scrollbar text-[11px] font-mono grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                    {parsedContacts.map((c, i) => (
                      <div key={i} className="p-1 bg-white rounded border border-slate-100 flex items-center justify-between gap-1">
                        <span className="truncate text-slate-900 font-bold">{c.name || <span className="text-slate-400 italic">NoName</span>}</span>
                        <span className="text-slate-500 text-[10px]">+{c.phone}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-100 pt-4"></div>

            {/* MESSAGING SYSTEM CONFIG */}
            <div className="flex flex-col gap-4">
              <div className="flex justify-between items-center flex-wrap gap-2">
                <label className="text-xs font-bold text-slate-900 uppercase">2. Message Configuration</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setMessageMode('common')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      messageMode === 'common' 
                        ? 'bg-slate-900 text-white' 
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200'
                    }`}
                  >
                    Common Message Mode
                  </button>
                  <button
                    type="button"
                    onClick={() => setMessageMode('personalized')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      messageMode === 'personalized' 
                        ? 'bg-slate-900 text-white' 
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-200'
                    }`}
                  >
                    Personalized Message Mode
                  </button>
                </div>
              </div>

              {/* Variable Hints for Personalized */}
              {messageMode === 'personalized' && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-semibold text-slate-600 flex items-start gap-2">
                  <Info className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span>Supports dynamic replacements. Use curly brackets:</span>
                    <ul className="list-disc ml-4 mt-1 font-mono text-[10px] space-y-0.5">
                      <li>Use <strong className="text-slate-950">{`{name}`}</strong> to inject the contact's name automatically.</li>
                      <li>Use <strong className="text-slate-950">{`{AnyColumnHeader}`}</strong> to pull custom fields imported from Excel.</li>
                    </ul>
                  </div>
                </div>
              )}

              {/* Template variations (supports multiple messages selected randomly to bypass anti-spam) */}
              <div className="flex flex-col gap-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-bold text-slate-800 uppercase">Message Templates (Randomized Variations)</span>
                  <button
                    type="button"
                    onClick={handleAddTemplateVariation}
                    className="flex items-center gap-1.5 text-xs text-emerald-600 font-extrabold hover:text-emerald-700"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Variation
                  </button>
                </div>

                <div className="space-y-3">
                  {templates.map((tmpl, idx) => (
                    <div key={idx} className="flex gap-2 items-start bg-slate-50 p-3 rounded-xl border border-slate-200">
                      <span className="text-xs font-black text-slate-800 pt-2.5">#{idx + 1}</span>
                      <textarea
                        rows={3}
                        value={tmpl}
                        onChange={(e) => handleTemplateChange(idx, e.target.value)}
                        placeholder={`Enter template text. Variations are selected randomly to prevent block risks.`}
                        className="flex-1 p-2 border border-slate-200 hover:border-slate-350 focus:border-emerald-500 focus:bg-white rounded-lg text-sm outline-none transition-all font-semibold"
                      ></textarea>
                      {templates.length > 1 && (
                        <button
                          type="button"
                          onClick={() => handleRemoveTemplateVariation(idx)}
                          className="p-2 text-rose-500 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors mt-2"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* MEDIA ATTACHMENT */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-slate-900 uppercase">Optional Media Attachment (Images / PDFs / Documents)</label>
                <div className="flex items-center gap-3">
                  <input 
                    type="file" 
                    onChange={(e) => setMediaFile(e.target.files?.[0] || null)}
                    className="text-xs border border-slate-200 rounded-lg p-2 flex-1"
                  />
                  {mediaFile && (
                    <button 
                      type="button" 
                      onClick={() => setMediaFile(null)}
                      className="p-2 text-rose-500 hover:bg-rose-50 border border-slate-250 rounded-lg text-xs"
                    >
                      Clear File
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="border-t border-slate-100 pt-4"></div>

            {/* QUEUE & ENGINE SETTINGS (ANTI-BAN MECHANISMS) */}
            <div className="flex flex-col gap-4 bg-emerald-50/40 p-5 rounded-2xl border border-emerald-100">
              <div className="flex items-center gap-2">
                <Info className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                <label className="text-xs font-bold text-slate-900 uppercase">3. Delivery Safety Engine (Auto-Configured)</label>
              </div>
              
              <p className="text-xs text-slate-600 font-semibold leading-relaxed">
                To safeguard your phone number from WhatsApp ban risks, safe sending limits have been hardcoded on the server. The campaign will execute automatically with the following parameters:
              </p>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-1">
                {/* Min Delay */}
                <div className="bg-white border border-slate-200 p-3 rounded-xl text-center">
                  <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Min Msg Delay</div>
                  <div className="text-sm font-black text-slate-900">5 Seconds</div>
                </div>
                {/* Max Delay */}
                <div className="bg-white border border-slate-200 p-3 rounded-xl text-center">
                  <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Max Msg Delay</div>
                  <div className="text-sm font-black text-slate-900">20 Seconds</div>
                </div>
                {/* Batch Size */}
                <div className="bg-white border border-slate-200 p-3 rounded-xl text-center">
                  <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Batch Size</div>
                  <div className="text-sm font-black text-slate-900">200 Contacts</div>
                </div>
                {/* Batch Cooldown */}
                <div className="bg-white border border-slate-200 p-3 rounded-xl text-center">
                  <div className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Batch Cooldown</div>
                  <div className="text-sm font-black text-slate-900">5 Minutes</div>
                </div>
              </div>
            </div>

            <div className="border-t border-slate-100 pt-4"></div>

            {/* SCHEDULER SECTION */}
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <input 
                  type="checkbox" 
                  id="scheduleCheck"
                  checked={isScheduled}
                  onChange={(e) => setIsScheduled(e.target.checked)}
                  className="w-4.5 h-4.5 text-emerald-500 rounded border-slate-350 accent-emerald-500"
                />
                <label htmlFor="scheduleCheck" className="text-xs font-bold text-slate-900 uppercase cursor-pointer selection:bg-none select-none">
                  Schedule campaign for future delivery
                </label>
              </div>

              {isScheduled && (
                <div className="flex flex-col gap-1.5 w-full sm:w-1/2 animate-fade-in">
                  <label className="text-[11px] font-bold text-slate-650">Execution Date & Time</label>
                  <input 
                    type="datetime-local" 
                    value={scheduledDate}
                    onChange={(e) => setScheduledDate(e.target.value)}
                    required={isScheduled}
                    className="p-2.5 bg-slate-50 border border-slate-200 focus:bg-white rounded-xl text-sm font-semibold outline-none"
                  />
                </div>
              )}
            </div>

            {/* Submit button */}
            <button
              type="submit"
              disabled={isSubmittingCampaign || sessions.length === 0}
              className="mt-6 flex items-center justify-center gap-2 w-full py-3.5 bg-slate-950 text-white font-extrabold rounded-xl hover:bg-slate-850 hover:shadow-md cursor-pointer transition-all disabled:bg-slate-300 disabled:cursor-not-allowed"
            >
              {isSubmittingCampaign ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-white" />
                  Generating Queue Campaign...
                </>
              ) : (
                <>
                  <Send className="w-5 h-5" />
                  {isScheduled ? 'Schedule Queue Campaign' : 'Start Bulk Campaign'}
                </>
              )}
            </button>
          </form>
        )}

        {/* ============================================================== */}
        {/* 3. WHATSAPP SESSIONS MANAGEMENT */}
        {/* ============================================================== */}
        {activeTab === 'sessions' && (
          <div className="flex flex-col gap-6 animate-slide-up max-w-4xl mx-auto">
            {/* Create session card */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs animated-card-border">
              <h2 className="text-lg font-black text-slate-900 uppercase tracking-wide border-b border-slate-100 pb-2 mb-4">Add Device / Session</h2>
              <form onSubmit={handleCreateSession} className="flex flex-col sm:flex-row gap-3">
                <input 
                  type="text" 
                  value={newSessionName}
                  onChange={(e) => setNewSessionName(e.target.value)}
                  placeholder="e.g. Sales Phone or Admin 98765..."
                  className="px-4 py-2.5 bg-slate-50 border border-slate-200 hover:border-slate-350 focus:border-emerald-500 focus:bg-white rounded-xl text-sm font-semibold outline-none flex-1 transition-all"
                  required
                />
                <button
                  type="submit"
                  disabled={isCreatingSession}
                  className="px-6 py-2.5 bg-emerald-500 text-white font-extrabold rounded-xl hover:bg-emerald-600 transition-colors shadow-sm flex items-center gap-2 cursor-pointer"
                >
                  {isCreatingSession ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Create Session node
                </button>
              </form>
            </div>

            {/* Sessions list */}
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-xs animated-card-border">
              <h2 className="text-lg font-black text-slate-900 uppercase tracking-wide border-b border-slate-100 pb-3 mb-4">WhatsApp Node Manager</h2>
              
              {loadingSessions ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
                  <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
                  <span className="text-sm font-semibold">Loading active sessions...</span>
                </div>
              ) : sessions.length === 0 ? (
                <div className="text-center py-12 text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50">
                  <Smartphone className="w-8 h-8 mx-auto text-slate-350 mb-2 animate-bounce" />
                  <h3 className="text-sm font-bold text-slate-800">No sessions linked</h3>
                  <p className="text-xs text-slate-500 mt-1 max-w-[250px] mx-auto">Create a session node to generate a WhatsApp Web pairing QR code.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {sessions.map(session => {
                    let statusColor = 'bg-slate-450';
                    let statusLabel = 'Offline';
                    if (session.status === 'CONNECTED') {
                      statusColor = 'bg-emerald-500';
                      statusLabel = 'Connected';
                    } else if (session.status === 'QR_READY') {
                      statusColor = 'bg-blue-500 animate-pulse';
                      statusLabel = 'Pairing QR Available';
                    } else if (session.status === 'CONNECTING') {
                      statusColor = 'bg-amber-500 animate-spin';
                      statusLabel = 'Connecting...';
                    }
                    
                    return (
                      <div key={session.id} className="p-5 rounded-xl border border-slate-250 hover:border-slate-400 bg-slate-50/50 transition-all flex flex-col gap-4 shadow-2xs">
                        <div className="flex justify-between items-start border-b border-slate-200 pb-3">
                          <div>
                            <h3 className="font-extrabold text-slate-900">{session.name}</h3>
                            <span className="text-[10px] font-mono text-slate-400 block mt-0.5">ID: {session.id}</span>
                          </div>
                          
                          <div className="flex items-center gap-1.5">
                            <span className={`w-2.5 h-2.5 rounded-full ${statusColor}`}></span>
                            <span className="text-xs font-bold text-slate-700">{statusLabel}</span>
                          </div>
                        </div>

                        {/* Middle info */}
                        <div className="flex-1">
                          {session.status === 'CONNECTED' ? (
                            <div className="text-xs font-semibold text-slate-600 bg-emerald-50/60 p-4 border border-emerald-100 rounded-xl flex items-center gap-3">
                              <CheckCircle className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                              <div>
                                <span className="font-bold text-emerald-800 block text-sm">Session Paired</span>
                                <span className="font-mono mt-0.5 block text-slate-700">Phone: +{session.phoneNumber}</span>
                              </div>
                            </div>
                          ) : session.status === 'QR_READY' && session.qrCode ? (
                            <div className="flex flex-col items-center gap-3 py-2">
                              <div className="bg-white p-3 rounded-lg border border-slate-200 shadow-sm animate-fade-in">
                                <img src={session.qrCode} alt="WhatsApp QR Code" className="w-[180px] h-[180px]" />
                              </div>
                              <span className="text-[11px] font-bold text-center text-slate-800 max-w-[200px] leading-relaxed">
                                Scan QR code with WhatsApp on your phone (Linked Devices &gt; Link a Device).
                              </span>
                            </div>
                          ) : session.status === 'CONNECTING' ? (
                            <div className="flex flex-col items-center justify-center py-10 gap-3">
                              <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
                              <span className="text-xs font-bold text-slate-600">Initializing chromium & requesting pairing token...</span>
                            </div>
                          ) : (
                            <div className="text-xs text-slate-500 p-4 bg-slate-100 border border-slate-200 rounded-xl text-center flex flex-col items-center gap-2">
                              <AlertCircle className="w-5 h-5 text-slate-400" />
                              <span>Session is currently offline. Restart connection to generate a pairing QR code.</span>
                            </div>
                          )}
                        </div>

                        {/* Footer actions */}
                        <div className="flex justify-between items-center gap-2 mt-2 pt-3 border-t border-slate-200">
                          <button
                            onClick={() => handleDeleteSession(session.id)}
                            className="p-2 text-rose-500 hover:text-rose-700 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors"
                            title="Delete Session"
                          >
                            <Trash2 className="w-4.5 h-4.5" />
                          </button>
                          
                          {session.status === 'DISCONNECTED' && (
                            <button
                              onClick={() => handleReconnectSession(session.id)}
                              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg transition-colors flex items-center gap-1 cursor-pointer"
                            >
                              <RefreshCw className="w-3.5 h-3.5" /> Connect Device
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* FOOTER */}
      <footer className="mt-auto bg-white border-t border-slate-200 py-6 px-6 text-center text-xs text-slate-500 font-semibold uppercase tracking-wider">
        <span>© {new Date().getFullYear()} BulkFlow Delivery Suite • Crafted Pair Programming</span>
      </footer>
    </div>
  );
}
