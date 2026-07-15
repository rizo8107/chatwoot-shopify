import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  addEdge,
  useNodesState,
  useEdgesState,
  Handle,
  Position,
  type Connection,
  type NodeProps,
  type Edge,
  type Node,
  BackgroundVariant,
  MiniMap,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const API = '/api';

// ─── Types ────────────────────────────────────────────────────────────────

interface Flow {
  id: string;
  name: string;
  description: string;
  trigger_event: string;
  nodes: Node[];
  edges: Edge[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

const TRIGGER_EVENTS = [
  { value: 'orders/create', label: 'Order Created' },
  { value: 'orders/paid', label: 'Order Paid' },
  { value: 'fulfillments/create', label: 'Fulfillment Created (Shipped)' },
];

const CONTEXT_FIELDS = [
  'phone', 'email', 'fullName', 'firstName', 'orderNumber', 'orderName', 'totalPrice',
  'itemsSummary', 'checkoutId', 'trackingNumber', 'trackingUrl', 'trackingCompany',
  'abandonedCheckoutUrl', 'orderStatusUrl', 'shippingCity',
];

const OPERATORS = [
  { value: 'exists', label: 'exists (not empty)' },
  { value: 'not_exists', label: 'does not exist (empty)' },
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
];

const DELAY_UNITS = ['minutes', 'hours', 'days'];

const NODE_PALETTE = [
  { type: 'delay', label: 'Delay', emoji: 'DL', desc: 'Wait before next step', color: 'var(--yellow)' },
  { type: 'condition', label: 'Condition', emoji: 'IF', desc: 'Branch on field value', color: 'var(--blue)' },
  { type: 'whatsapp', label: 'Send WhatsApp', emoji: 'WA', desc: 'Send template message', color: 'var(--green)' },
  { type: 'fetchShopify', label: 'Fetch Shopify', emoji: 'SH', desc: 'Fetch order/checkout data', color: 'var(--text-muted)' },
];

function genId(prefix = 'node') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
}

function makeDefaultNode(type: string, position: { x: number; y: number }): Node {
  const id = genId(type);
  const baseData: Record<string, any> = { label: type };
  if (type === 'trigger') { baseData.event = 'orders/create'; baseData.label = 'Trigger'; }
  if (type === 'delay') { baseData.duration = 1; baseData.unit = 'hours'; baseData.label = 'Delay'; }
  if (type === 'condition') { baseData.field = 'phone'; baseData.operator = 'exists'; baseData.value = ''; baseData.label = 'Condition'; }
  if (type === 'whatsapp') { baseData.templateName = ''; baseData.templateMapping = ''; baseData.label = 'Send WhatsApp'; }
  if (type === 'fetchShopify') { baseData.fetchType = 'order'; baseData.label = 'Fetch Shopify'; }
  return { id, type, position, data: baseData };
}

// ─── Custom Nodes ──────────────────────────────────────────────────────────

function TriggerNode({ data, selected }: NodeProps) {
  const ev = TRIGGER_EVENTS.find(e => e.value === (data as any).event);
  return (
    <div className={`rf-node trigger${selected ? ' selected' : ''}`}>
      <div className="rf-node-icon">TR</div>
      <div className="rf-node-label">Trigger</div>
      <div className="rf-node-title">{ev?.label || (data as any).event || 'Select Event'}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--accent)' }} />
    </div>
  );
}

function DelayNode({ data, selected }: NodeProps) {
  const d = data as any;
  return (
    <div className={`rf-node delay${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--yellow)' }} />
      <div className="rf-node-icon">DL</div>
      <div className="rf-node-label">Delay</div>
      <div className="rf-node-title">Wait {d.duration || 1} {d.unit || 'hours'}</div>
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--yellow)' }} />
    </div>
  );
}

function ConditionNode({ data, selected }: NodeProps) {
  const d = data as any;
  return (
    <div className={`rf-node condition${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--blue)' }} />
      <div className="rf-node-icon">IF</div>
      <div className="rf-node-label">Condition</div>
      <div className="rf-node-title">{d.field || 'field'} {d.operator || 'exists'}</div>
      {d.value && <div className="rf-node-sub">value: {d.value}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 10 }}>
        <span style={{ color: 'var(--green)' }}>Yes ↙</span>
        <span style={{ color: 'var(--red)' }}>↘ No</span>
      </div>
      <Handle type="source" id="yes" position={Position.Bottom} style={{ left: '25%', background: 'var(--green)' }} />
      <Handle type="source" id="no" position={Position.Bottom} style={{ left: '75%', background: 'var(--red)' }} />
    </div>
  );
}

function WhatsAppNode({ data, selected }: NodeProps) {
  const d = data as any;
  return (
    <div className={`rf-node whatsapp${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} style={{ background: 'var(--green)' }} />
      <div className="rf-node-icon">WA</div>
      <div className="rf-node-label">Send WhatsApp</div>
      <div className="rf-node-title">{d.templateName || 'Select template'}</div>
      {d.templateMapping && <div className="rf-node-sub">vars: {d.templateMapping}</div>}
      <Handle type="source" position={Position.Bottom} style={{ background: 'var(--green)' }} />
    </div>
  );
}

function FetchShopifyNode({ data, selected }: NodeProps) {
  const d = data as any;
  return (
    <div className={`rf-node fetchShopify${selected ? ' selected' : ''}`}>
      <Handle type="target" position={Position.Top} />
      <div className="rf-node-icon">SH</div>
      <div className="rf-node-label">Fetch Shopify</div>
      <div className="rf-node-title">Fetch {d.fetchType || 'order'} data</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const NODE_TYPES = { trigger: TriggerNode, delay: DelayNode, condition: ConditionNode, whatsapp: WhatsAppNode, fetchShopify: FetchShopifyNode };

// ─── Node Config Panel ─────────────────────────────────────────────────────

function NodeConfigPanel({ node, onChange, onDelete }: { node: Node; onChange: (data: any) => void; onDelete: () => void }) {
  const d = node.data as any;
  const set = (key: string, val: any) => onChange({ ...d, [key]: val });

  const [templates, setTemplates] = useState<{ name: string; language: string; category: string; paramCount: number }[]>([]);
  useEffect(() => {
    if (node.type !== 'whatsapp') return;
    fetch(`${API}/whatsapp/templates`).then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {});
  }, [node.type]);

  return (
    <div className="flow-config-panel">
      <div className="flow-config-header">
        Configure: {d.label || node.type}
        <button className="btn btn-ghost btn-sm btn-icon" style={{ float: 'right', marginTop: -2 }} onClick={onDelete} title="Delete node">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>
      </div>
      <div className="flow-config-body">
        {/* Label */}
        <div className="form-group">
          <label className="form-label">Node Label</label>
          <input className="input" value={d.label || ''} onChange={e => set('label', e.target.value)} placeholder="e.g. Wait 1 hour" />
        </div>

        {/* Trigger */}
        {node.type === 'trigger' && (
          <div className="form-group">
            <label className="form-label">Shopify Event</label>
            <select className="select" value={d.event || ''} onChange={e => set('event', e.target.value)}>
              <option value="">Select event...</option>
              {TRIGGER_EVENTS.map(ev => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
            </select>
            <div className="form-hint">The Shopify webhook topic that starts this flow.</div>
          </div>
        )}

        {/* Delay */}
        {node.type === 'delay' && (
          <>
            <div className="form-group">
              <label className="form-label">Wait Duration</label>
              <input className="input" type="number" min="1" value={d.duration || 1} onChange={e => set('duration', parseInt(e.target.value) || 1)} />
            </div>
            <div className="form-group">
              <label className="form-label">Unit</label>
              <select className="select" value={d.unit || 'hours'} onChange={e => set('unit', e.target.value)}>
                {DELAY_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
          </>
        )}

        {/* Condition */}
        {node.type === 'condition' && (
          <>
            <div className="form-group">
              <label className="form-label">Field to Check</label>
              <select className="select" value={d.field || ''} onChange={e => set('field', e.target.value)}>
                <option value="">Select field...</option>
                {CONTEXT_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Operator</label>
              <select className="select" value={d.operator || 'exists'} onChange={e => set('operator', e.target.value)}>
                {OPERATORS.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
              </select>
            </div>
            {(d.operator === 'equals' || d.operator === 'not_equals' || d.operator === 'contains') && (
              <div className="form-group">
                <label className="form-label">Value</label>
                <input className="input" value={d.value || ''} onChange={e => set('value', e.target.value)} placeholder="Value to compare" />
              </div>
            )}
            <div className="callout info">
              Connect the <strong style={{ color: 'var(--green)' }}>left/Yes</strong> handle for the true branch,
              and the <strong style={{ color: 'var(--red)' }}>right/No</strong> handle for the false branch.
            </div>
          </>
        )}

        {/* WhatsApp */}
        {node.type === 'whatsapp' && (
          <>
            <div className="form-group">
              <label className="form-label">Template Name</label>
              {templates.length > 0 && (
                <select className="select" style={{ marginBottom: 6 }} value={templates.some(t => t.name === d.templateName) ? d.templateName : ''}
                  onChange={e => { if (e.target.value) set('templateName', e.target.value); }}>
                  <option value="">— pick a template from Chatwoot —</option>
                  {templates.map(t => <option key={t.name} value={t.name}>{t.name} · {t.language} · {t.paramCount} var{t.paramCount !== 1 ? 's' : ''}</option>)}
                </select>
              )}
              <input className="input" value={d.templateName || ''} onChange={e => set('templateName', e.target.value)} placeholder="e.g. abandoned_cart_01" />
              <div className="form-hint">Pick from Chatwoot, or type the exact template name.</div>
            </div>
            <div className="form-group">
              <label className="form-label">Variable Mapping</label>
              <select className="select" style={{ marginBottom: 6 }}
                onChange={e => {
                  if (!e.target.value) return;
                  const curr = (d.templateMapping || '').split(',').map((s: string) => s.trim()).filter(Boolean);
                  if (!curr.includes(e.target.value)) {
                    set('templateMapping', [...curr, e.target.value].join(', '));
                  }
                  e.target.value = '';
                }}>
                <option value="">+ Add variable...</option>
                {CONTEXT_FIELDS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
              <input className="input" value={d.templateMapping || ''} onChange={e => set('templateMapping', e.target.value)} placeholder="e.g. fullName, orderName, orderStatusUrl" />
              <div className="form-hint">Comma-separated field names — maps to {'{{1}}'}, {'{{2}}'}, {'{{3}}'}, etc.</div>
            </div>
          </>
        )}

        {/* Fetch Shopify */}
        {node.type === 'fetchShopify' && (
          <div className="form-group">
            <label className="form-label">Fetch Type</label>
            <select className="select" value={d.fetchType || 'order'} onChange={e => set('fetchType', e.target.value)}>
              <option value="order">Order</option>
              <option value="checkout">Checkout</option>
            </select>
            <div className="form-hint">Requires Shopify Admin API configured in Settings.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Flow Editor Canvas ────────────────────────────────────────────────────

function FlowEditor({ flow, onBack, onSaved }: { flow: Flow | null; onBack: () => void; onSaved: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(flow?.nodes || []);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flow?.edges || []);
  const [name, setName] = useState(flow?.name || 'Untitled Flow');
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const reactFlowWrapper = useRef<HTMLDivElement>(null);

  const onConnect = useCallback((params: Connection) =>
    setEdges(eds => addEdge({ ...params, animated: true, style: { stroke: 'var(--border-strong)' } }, eds)),
    [setEdges]
  );

  const onNodeClick = useCallback((_: any, node: Node) => setSelectedNode(node), []);
  const onPaneClick = useCallback(() => setSelectedNode(null), []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/reactflow-type');
    if (!type || !reactFlowWrapper.current) return;
    const bounds = reactFlowWrapper.current.getBoundingClientRect();
    const position = { x: e.clientX - bounds.left - 90, y: e.clientY - bounds.top - 40 };
    const newNode = makeDefaultNode(type, position);
    setNodes(nds => [...nds, newNode]);
  }, [setNodes]);

  const updateNodeData = useCallback((nodeId: string, data: any) => {
    setNodes(nds => nds.map(n => n.id === nodeId ? { ...n, data } : n));
    setSelectedNode(prev => prev?.id === nodeId ? { ...prev, data } : prev);
  }, [setNodes]);

  const deleteNode = useCallback((nodeId: string) => {
    setNodes(nds => nds.filter(n => n.id !== nodeId));
    setEdges(eds => eds.filter(e => e.source !== nodeId && e.target !== nodeId));
    setSelectedNode(null);
  }, [setNodes, setEdges]);

  const addTriggerNode = () => {
    const hasTrigger = nodes.some(n => n.type === 'trigger');
    if (hasTrigger) { setSaveMsg('Only one Trigger node allowed per flow.'); setTimeout(() => setSaveMsg(''), 3000); return; }
    const n = makeDefaultNode('trigger', { x: 300, y: 80 });
    setNodes(nds => [...nds, n]);
  };

  const save = async () => {
    setSaving(true);
    const triggerNode = nodes.find(n => n.type === 'trigger');
    if (!triggerNode) {
      setSaveMsg('Error: A Trigger node is required to save the flow.');
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 4000);
      return;
    }
    const triggerEvent = (triggerNode.data as any)?.event || 'orders/create';
    try {
      const res = await fetch(`${API}/flows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: flow?.id, name, trigger_event: triggerEvent, nodes, edges, is_active: flow?.is_active !== false })
      });
      if (!res.ok) throw new Error('Save failed');
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2000);
      onSaved();
    } catch (err: any) {
      setSaveMsg(`Error: ${err.message}`);
    }
    setSaving(false);
  };

  return (
    <div className="flow-editor">
      {/* Left Palette */}
      <div className="flow-sidebar">
        <div className="flow-sidebar-header">
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onBack} title="Back to flows list">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
          </button>
          <span style={{ fontSize: 12, fontWeight: 600 }}>Node Palette</span>
        </div>

        <div style={{ padding: '8px 0' }}>
          <div className="sidebar-section-label">Trigger</div>
          <div
            className="node-palette-item"
            onClick={addTriggerNode}
            style={{ cursor: 'pointer' }}
          >
            <div className="node-icon" style={{ background: 'var(--accent-dim)', fontSize: 16 }}>⚡</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 12 }}>Trigger</div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>Start of flow</div>
            </div>
          </div>

          <div className="sidebar-section-label" style={{ marginTop: 8 }}>Actions</div>
          {NODE_PALETTE.map(n => (
            <div
              key={n.type}
              className="node-palette-item"
              draggable
              onDragStart={e => e.dataTransfer.setData('application/reactflow-type', n.type)}
            >
              <div className="node-icon" style={{ background: 'var(--bg-hover)' }}>{n.emoji}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 12 }}>{n.label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{n.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', marginTop: 'auto', fontSize: 11, color: 'var(--text-dim)' }}>
          Drag nodes onto the canvas, then connect them by dragging between ports.
        </div>
      </div>

      {/* Canvas */}
      <div className="flow-canvas-area" ref={reactFlowWrapper} onDrop={onDrop} onDragOver={onDragOver}>
        {/* Top Bar */}
        <div className="flow-top-bar">
          <input
            className="flow-name-input"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Flow name..."
          />
          <div style={{ width: 1, height: 20, background: 'var(--border)', flexShrink: 0 }} />
          {saveMsg && <span style={{ fontSize: 12, color: saveMsg.startsWith('Error') ? 'var(--red)' : 'var(--green)' }}>{saveMsg}</span>}
          <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? <span className="spinner" style={{ width: 12, height: 12 }} /> : null}
            Save Flow
          </button>
        </div>

        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          nodeTypes={NODE_TYPES}
          fitView
          deleteKeyCode="Delete"
          style={{ background: 'var(--bg)' }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--border)" />
          <Controls style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, bottom: 16, left: 16 }} />
          <MiniMap
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 8, bottom: 16, right: 16 }}
            nodeColor={() => 'var(--border-strong)'}
          />
        </ReactFlow>
      </div>

      {/* Right Config */}
      {selectedNode ? (
        <NodeConfigPanel
          node={selectedNode}
          onChange={data => updateNodeData(selectedNode.id, data)}
          onDelete={() => deleteNode(selectedNode.id)}
        />
      ) : (
        <div className="flow-config-panel">
          <div className="flow-config-header">Node Settings</div>
          <div className="flow-config-body">
            <div className="empty-state" style={{ padding: '30px 0' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <h3 style={{ marginTop: 8, fontSize: 13 }}>Click a node to configure it</h3>
              <p>Select any node on the canvas to edit its settings here.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Flow List ─────────────────────────────────────────────────────────────

function FlowList({ onEdit, onCreate }: { onEdit: (f: Flow) => void; onCreate: () => void }) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [loading, setLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [webhookInfo, setWebhookInfo] = useState<any>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [fRes, wRes] = await Promise.all([fetch(`${API}/flows`), fetch(`${API}/webhook/info`)]);
      setFlows(await fRes.json());
      const wi = await wRes.json();
      setWebhookUrl(wi.webhookUrl || '');
      setWebhookInfo(wi);
    } catch (_) {}
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const toggle = async (flow: Flow) => {
    await fetch(`${API}/flows/${flow.id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !flow.is_active })
    });
    load();
  };

  const del = async (flow: Flow) => {
    if (!confirm(`Delete flow "${flow.name}"? This also cancels any pending scheduled jobs.`)) return;
    await fetch(`${API}/flows/${flow.id}`, { method: 'DELETE' });
    load();
  };

  const copy = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Automation Flows</div>
          <div className="page-sub">Build drag-and-drop automation sequences triggered by Shopify events</div>
        </div>
        <button className="btn btn-primary" onClick={onCreate}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Flow
        </button>
      </div>

      {/* Shopify Webhook Setup */}
      <div className="card mb-4">
        <div className="card-header">
          <div>
            <div className="card-title">Shopify Webhook Setup</div>
            <div className="card-sub">Add this URL in Shopify Admin → Settings → Notifications → Webhooks → Add webhook</div>
          </div>
        </div>
        <div className="webhook-url-box" style={{ marginBottom: 12 }}>
          <span className="webhook-url-text">{webhookUrl || '...'}</span>
          <button className="btn btn-secondary btn-sm" onClick={copy}>
            {copied
              ? <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg> Copied</>
              : <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy URL</>
            }
          </button>
        </div>
        {webhookInfo?.supportedEvents && (
          <div>
            <div className="text-sm text-dim mb-2">Supported Shopify topics — register whichever you use in your flows:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {webhookInfo.supportedEvents.map((ev: any) => (
                <span key={ev.event} className="badge pending" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{ev.event}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Flows Table */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Your Flows</div>
        </div>

        {loading ? (
          <div className="empty-state" style={{ padding: 30 }}><span className="spinner" /></div>
        ) : flows.length === 0 ? (
          <div className="empty-state">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="5" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M5 8v2a4 4 0 0 0 4 4h2"/><path d="M14 12h2a4 4 0 0 1 4 4v2"/></svg>
            <h3>No flows yet</h3>
            <p>Create your first automation flow to start sending WhatsApp messages automatically.</p>
            <button className="btn btn-primary btn-sm mt-3" onClick={onCreate}>Create First Flow</button>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Flow Name</th>
                  <th>Trigger Event</th>
                  <th>Nodes</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {flows.map(flow => (
                  <tr key={flow.id} onClick={() => onEdit(flow)}>
                    <td style={{ fontWeight: 600 }}>{flow.name}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{flow.trigger_event}</td>
                    <td className="muted">{flow.nodes.length} nodes, {flow.edges.length} edges</td>
                    <td onClick={e => e.stopPropagation()}>
                      <label className="toggle" title={flow.is_active ? 'Active — click to disable' : 'Inactive — click to enable'}>
                        <input type="checkbox" checked={flow.is_active} onChange={() => toggle(flow)} />
                        <span className="toggle-slider" />
                      </label>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>{new Date(flow.updated_at).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                      <div className="flex gap-2" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => onEdit(flow)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => del(flow)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main FlowBuilder Component ────────────────────────────────────────────

export const FlowBuilder: React.FC = () => {
  const [view, setView] = useState<'list' | 'editor'>('list');
  const [editingFlow, setEditingFlow] = useState<Flow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const openEditor = (flow: Flow | null) => {
    setEditingFlow(flow);
    setView('editor');
  };

  const backToList = () => {
    setView('list');
    setEditingFlow(null);
    setRefreshKey(k => k + 1);
  };

  if (view === 'editor') {
    return (
      <FlowEditor
        flow={editingFlow}
        onBack={backToList}
        onSaved={() => {}}
      />
    );
  }

  return <FlowList key={refreshKey} onEdit={openEditor} onCreate={() => openEditor(null)} />;
};
