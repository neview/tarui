import styles from "./index.module.scss";
import fejiWhite from "../../assets/1(1).png";
import fejiDark from "../../assets/1(2).png";
import kuaishouWhite from "../../assets/1(3).png";
import kuaishouDark from "../../assets/1(4).png";
import douyinWhite from "../../assets/1(5).png";
import douyinDark from "../../assets/1(6).png";
import weixinWhite from "../../assets/1(7).png";
import weixinDark from "../../assets/1(8).png";
import qqWhite from "../../assets/1(9).png";
import qqDark from "../../assets/1(10).png";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";

interface MenuItem {
  lightIcon: string;
  darkIcon: string;
  path: string;
}

export function LeftMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const parentRef = useRef<HTMLDivElement>(null);
  const imgList: MenuItem[] = [
    { lightIcon: fejiWhite, darkIcon: fejiDark, path: "/feiji" },
    { lightIcon: kuaishouWhite, darkIcon: kuaishouDark, path: "/kuaishou" },
    { lightIcon: douyinWhite, darkIcon: douyinDark, path: "/douyin" },
    { lightIcon: weixinWhite, darkIcon: weixinDark, path: "/weixin" },
    { lightIcon: qqWhite, darkIcon: qqDark, path: "/qq" },
  ];
  
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [style, setStyle] = useState({ transform: "translateY(0px)" });
  const [animatingIndex, setAnimatingIndex] = useState<number | null>(null);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const checkDark = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };
    checkDark();
    
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, { 
      attributes: true, 
      attributeFilter: ['class'] 
    });
    
    return () => observer.disconnect();
  }, []);

  // 根据当前路由路径确定选中的菜单项
  useEffect(() => {
    const currentIndex = imgList.findIndex(item => item.path === location.pathname);
    if (currentIndex !== -1 && currentIndex !== selectedIndex) {
      setSelectedIndex(currentIndex);
      // 更新指示器位置
      if (parentRef.current) {
        const parentRect = parentRef.current.getBoundingClientRect();
        const items = parentRef.current.querySelectorAll('img');
        const targetItem = items[currentIndex] as HTMLImageElement;
        if (targetItem) {
          const targetRect = targetItem.getBoundingClientRect();
          setStyle({
            transform: `translateY(${targetRect.top - parentRect.top - 8}px)`,
          });
        }
      }
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!parentRef.current) return;
    const parentRect = parentRef.current.getBoundingClientRect();
    const firstItem = parentRef.current.querySelector(`img:nth-child(1)`) as HTMLImageElement;
    if (!firstItem) return;
    const firstItemRect = firstItem.getBoundingClientRect();
    setStyle({
      transform: `translateY(${firstItemRect.top - parentRect.top - 8}px)`,
    });
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLImageElement>, index: number) => {
    if (!parentRef.current) return;
    const parentRect = parentRef.current.getBoundingClientRect();
    const targetRect = e.currentTarget.getBoundingClientRect();
    setStyle({
      transform: `translateY(${targetRect.top - parentRect.top - 8}px)`,
    });
    setSelectedIndex(index);
    
    // 触发动画
    setAnimatingIndex(index);
    setTimeout(() => {
      setAnimatingIndex(null);
    }, 300);

    // 导航到对应路由
    navigate(imgList[index].path);
  };

  // 获取图标：选中时滑块会高亮，图标需在滑块上可见；未选中时随背景
  const getIcon = (item: MenuItem, isSelected: boolean) => {
    if (isSelected) {
      // 选中：白天深色滑块用白图标，黑夜半透明白滑块也用白图标
      return item.lightIcon;
    }
    // 未选中：白天浅色背景用深色图标，黑夜深色背景用白图标
    return isDark ? item.lightIcon : item.darkIcon;
  };

  return (
    <div className={styles.left_menu} ref={parentRef}>
      {imgList.map((item, index) => (
        <img
          key={index}
          src={getIcon(item, selectedIndex === index)}
          alt=""
          onClick={(e) => handleClick(e, index)}
          className={animatingIndex === index ? styles.scaleAnim : ""}
        />
      ))}
      <div className={styles.left_menu_item} style={style}></div>
    </div>
  );
}
