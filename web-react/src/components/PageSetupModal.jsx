// 页面设置弹窗：纸张/方向/边距/页眉/页脚/页码
import { useState, useEffect } from 'react';
import { Modal, Form, Select, InputNumber, Checkbox, Input, Space, message } from 'antd';
import { store, useStore } from '../store.js';

export default function PageSetupModal() {
  const open = useStore('pageSetupOpen');
  const docModel = useStore('docModel');
  const [form] = Form.useForm();
  const ps = docModel?.pageSetup;

  useEffect(() => {
    if (open && ps) {
      form.setFieldsValue({
        size: ps.size || 'A4',
        orientation: ps.orientation || 'portrait',
        marginTop: ps.margins?.top ?? 25.4,
        marginBottom: ps.margins?.bottom ?? 25.4,
        marginLeft: ps.margins?.left ?? 31.8,
        marginRight: ps.margins?.right ?? 31.8,
        headerEnabled: !!ps.header?.enabled,
        headerText: (ps.header?.content || []).map(c => c.text || '').join(' '),
        footerEnabled: !!ps.footer?.enabled,
        footerText: (ps.footer?.content || []).map(c => c.text || '').join(' '),
        pnEnabled: !!ps.pageNumber?.enabled,
        pnPosition: ps.pageNumber?.position || 'footer-center',
        pnFormat: ps.pageNumber?.format || 'decimal',
        pnStart: ps.pageNumber?.startAt ?? 1,
      });
    }
  }, [open, ps, form]);

  const save = async () => {
    const v = form.getFieldsValue();
    // 内容未改动时保留原有多段/对齐结构，避免被单块覆盖
    const join = (c) => (c || []).map(x => x.text || '').join(' ');
    const headerContent = v.headerText === join(ps.header?.content) ? ps.header.content : (v.headerText ? [{ text: v.headerText, align: 'center' }] : []);
    const footerContent = v.footerText === join(ps.footer?.content) ? ps.footer.content : (v.footerText ? [{ text: v.footerText, align: 'center' }] : []);
    docModel.pageSetup = {
      ...ps,
      size: v.size,
      orientation: v.orientation,
      margins: { top: v.marginTop, bottom: v.marginBottom, left: v.marginLeft, right: v.marginRight },
      header: { ...ps.header, enabled: v.headerEnabled, content: headerContent },
      footer: { ...ps.footer, enabled: v.footerEnabled, content: footerContent },
      pageNumber: { ...ps.pageNumber, enabled: v.pnEnabled, position: v.pnPosition, format: v.pnFormat, startAt: v.pnStart },
    };
    if (await store.applyModelChange('format: 页面设置')) {
      store.set({ pageSetupOpen: false });
      message.success('页面设置已更新');
    } else {
      message.error('保存失败');
    }
  };

  return (
    <Modal open={!!open} title="页面设置" width={560} okText="保存" onOk={save} onCancel={() => store.set({ pageSetupOpen: false })}>
      <Form form={form} labelCol={{ span: 5 }} size="middle">
        <Form.Item label="纸张" name="size">
          <Select options={['A4', 'Letter'].map(v => ({ value: v }))} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="方向" name="orientation">
          <Select options={[{ value: 'portrait', label: '纵向' }, { value: 'landscape', label: '横向' }]} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="边距 (mm)" style={{ marginBottom: 0 }}>
          <Space>
            上 <Form.Item name="marginTop" noStyle><InputNumber step={0.1} style={{ width: 68 }} /></Form.Item>
            下 <Form.Item name="marginBottom" noStyle><InputNumber step={0.1} style={{ width: 68 }} /></Form.Item>
            左 <Form.Item name="marginLeft" noStyle><InputNumber step={0.1} style={{ width: 68 }} /></Form.Item>
            右 <Form.Item name="marginRight" noStyle><InputNumber step={0.1} style={{ width: 68 }} /></Form.Item>
          </Space>
        </Form.Item>
        <Form.Item label="页眉" style={{ marginBottom: 0, marginTop: 24 }}>
          <Space>
            <Form.Item name="headerEnabled" valuePropName="checked" noStyle><Checkbox>启用</Checkbox></Form.Item>
            <Form.Item name="headerText" noStyle><Input placeholder="页眉文字" style={{ width: 280 }} /></Form.Item>
          </Space>
        </Form.Item>
        <Form.Item label="页脚">
          <Space>
            <Form.Item name="footerEnabled" valuePropName="checked" noStyle><Checkbox>启用</Checkbox></Form.Item>
            <Form.Item name="footerText" noStyle><Input placeholder="页脚文字" style={{ width: 280 }} /></Form.Item>
          </Space>
        </Form.Item>
        <Form.Item label="页码">
          <Space>
            <Form.Item name="pnEnabled" valuePropName="checked" noStyle><Checkbox>启用</Checkbox></Form.Item>
            <Form.Item name="pnPosition" noStyle>
              <Select options={[
                { value: 'footer-center', label: '页脚居中' }, { value: 'footer-left', label: '页脚居左' },
                { value: 'footer-right', label: '页脚居右' }, { value: 'header-center', label: '页眉居中' },
              ]} style={{ width: 110 }} />
            </Form.Item>
            起始 <Form.Item name="pnStart" noStyle><InputNumber min={0} style={{ width: 64 }} /></Form.Item>
            格式 <Form.Item name="pnFormat" noStyle>
              <Select options={[
                { value: 'decimal', label: '1, 2, 3' },
                { value: 'lowerRoman', label: 'i, ii, iii' },
                { value: 'upperRoman', label: 'I, II, III' },
                { value: 'lowerLetter', label: 'a, b, c' },
                { value: 'upperLetter', label: 'A, B, C' },
              ]} style={{ width: 96 }} />
            </Form.Item>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}
