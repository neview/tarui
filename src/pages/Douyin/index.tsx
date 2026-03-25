// 组件切换动效 “实现一个基于时间轴的纹理扭曲动画。对象在位移过程中，其几何形状需经历底端优先收缩的变形。具体表现为：靠近目标点（Sink Point）的边缘以指数级速率向中心挤压，而远离目标点的边缘保持滞后收缩，形成类似流体被吸入孔洞的视觉感知。同时配合透明度（Opacity）和高斯模糊（Gaussian Blur）的微量变化，以增强运动模糊感。”

import { useState, useRef, useCallback } from "react";
import BottomNav from "./BottomNav";
import GenieTransition from "./GenieTransition";
import {
  HomePage,
  BookmarkPage,
  PublishPage,
  ProfilePage,
  SettingsPage,
} from "./panels";

const panels = [HomePage, BookmarkPage, PublishPage, ProfilePage, SettingsPage];

export default function Douyin() {
  const [displayPanel, setDisplayPanel] = useState(0);
  const [targetPanel, setTargetPanel] = useState(0);
  const [animState, setAnimState] = useState<
    "idle" | "exiting" | "entering"
  >("idle");
  const [sinkX, setSinkX] = useState(50);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleNavChange = useCallback(
    (index: number, iconCenterX: number) => {
      if (index === displayPanel || animState !== "idle") return;

      const el = contentRef.current;
      if (el) {
        const rect = el.getBoundingClientRect();
        const pct = ((iconCenterX - rect.left) / rect.width) * 100;
        setSinkX(Math.max(0, Math.min(100, pct)));
      }

      setTargetPanel(index);
      setAnimState("exiting");
    },
    [displayPanel, animState],
  );

  const handleAnimComplete = useCallback(() => {
    if (animState === "exiting") {
      setDisplayPanel(targetPanel);
      setAnimState("entering");
    } else if (animState === "entering") {
      setAnimState("idle");
    }
  }, [animState, targetPanel]);

  const activeTab = animState === "idle" ? displayPanel : targetPanel;
  const Panel = panels[displayPanel];

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <div ref={contentRef} className="absolute inset-0">
        <GenieTransition
          state={animState}
          sinkXPercent={sinkX}
          onComplete={handleAnimComplete}
        >
          <Panel />
        </GenieTransition>
      </div>
      <BottomNav active={activeTab} onChange={handleNavChange} />
    </div>
  );
}
