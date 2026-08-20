// 样式编辑弹窗：字号/字体/粗斜体/颜色/对齐/段前段后/行距
import { useState, useEffect } from 'react';
import { Modal, Form, InputNumber, Input, Checkbox, Select, Space, message } from 'antd';
import { store, useStore } from '../store.js';

export default function StyleModal() {
  const styleEditId = useStore('styleEditId');
  const docModel = useStore('docModel');
  const [form] = Form.useForm();
  const st = styleEditId ? docModel?.styles?.[styleEditId] : null;

  useEffect(() => {
    if (styleEditId && st) {
      form.setFieldsValue({
        fontSize: st.fontSize,
        font: st.font,
        bold: !!st.bold,
        italic: !!st.italic,
        color: st.color ? (st.color.startsWith('#') ? st.color : '#' + st.color) : '',
        alignment: st.alignment || '',
        spaceBefore: st.spaceBefore,
        spaceAfter: st.spaceAfter,
        lineHeight: st.lineHeight,
      });
    }
  }, [styleEditId, st, form]);

  const close = () => store.set({ styleEditId: null });

  const save = async () => {
    const v = form.getFieldsValue();
    docModel.styles[styleEditId] = {
      ...st,
      fontSize: v.fontSize ?? undefined,
      font: v.font || undefined,
      bold: v.bold,
      italic: v.italic,
      color: v.color || undefined,
      alignment: v.alignment || undefined,
      spaceBefore: v.spaceBefore ?? undefined,
      spaceAfter: v.spaceAfter ?? undefined,
      lineHeight: v.lineHeight ?? undefined,
    };
    if (await store.applyModelChange(`format: 样式 ${st.name || styleEditId}`)) {
      close();
      message.success('样式已更新');
    } else {
      message.error('保存失败');
    }
  };

  return (
    <Modal open={!!styleEditId} title={`样式：${st?.name || styleEditId || ''}`} width={480} okText="保存" onOk={save} onCancel={close}>
      <Form form={form} labelCol={{ span: 6 }} size="middle">
        <Form.Item label="字号 (pt)" name="fontSize"><InputNumber step={0.5} style={{ width: 120 }} /></Form.Item>
        <Form.Item label="字体" name="font"><Input placeholder="如 宋体 / Times New Roman" /></Form.Item>
        <Form.Item label="粗体 / 斜体">
          <Space>
            <Form.Item name="bold" valuePropName="checked" noStyle><Checkbox>粗体</Checkbox></Form.Item>
            <Form.Item name="italic" valuePropName="checked" noStyle><Checkbox>斜体</Checkbox></Form.Item>
          </Space>
        </Form.Item>
        <Form.Item label="颜色" name="color"><Input placeholder="#333333" style={{ width: 140 }} /></Form.Item>
        <Form.Item label="对齐" name="alignment">
          <Select allowClear options={[
            { value: 'left', label: '居左' }, { value: 'center', label: '居中' },
            { value: 'right', label: '居右' }, { value: 'both', label: '两端对齐' },
          ]} style={{ width: 140 }} />
        </Form.Item>
        <Form.Item label="段前/段后 (mm)">
          <Space>
            <Form.Item name="spaceBefore" noStyle><InputNumber step={0.5} style={{ width: 90 }} /></Form.Item>
            <Form.Item name="spaceAfter" noStyle><InputNumber step={0.5} style={{ width: 90 }} /></Form.Item>
          </Space>
        </Form.Item>
        <Form.Item label="行距" name="lineHeight">
          <Select allowClear options={[{ value: 1.15 }, { value: 1.5 }, { value: 2 }]} style={{ width: 120 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
