import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface LoginFormProps {
  onSubmit?: (data: FormData) => void;
}

export interface FormData {
  email: string;
  password: string;
  gender: string;
  birthday: string;
  description: string;
}

export function LoginForm({ onSubmit }: LoginFormProps) {
  const [birthday, setBirthday] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [gender, setGender] = useState("male");
  const datePickerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭日期选择器
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (datePickerRef.current && !datePickerRef.current.contains(event.target as Node)) {
        setShowDatePicker(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // 生成月份的天数
  const getDaysInMonth = (year: number, month: number) => {
    return new Date(year, month + 1, 0).getDate();
  };

  // 获取每月第一天是周几
  const getFirstDayOfMonth = (year: number, month: number) => {
    return new Date(year, month, 1).getDay();
  };

  const [currentYear, setCurrentYear] = useState(new Date().getFullYear());
  const [currentMonth, setCurrentMonth] = useState(new Date().getMonth());

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);
  const emptyDays = Array.from({ length: firstDay }, (_, i) => i);

  const handleDateClick = (day: number) => {
    const date = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    setBirthday(date);
    setShowDatePicker(false);
  };

  const prevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const nextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  const weekDays = ["日", "一", "二", "三", "四", "五", "六"];
  const monthNames = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const formData = new FormData(e.target as HTMLFormElement);
    if (onSubmit) {
      onSubmit({
        email: formData.get("email") as string,
        password: formData.get("password") as string,
        gender,
        birthday,
        description: formData.get("description") as string,
      });
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" placeholder="name@example.com" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="password">Password</Label>
          <div className="relative">
            <Input 
              id="password" 
              name="password"
              type={showPassword ? "text" : "password"} 
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500"
            >
              {showPassword ? "👁" : "👁‍🗨"}
            </button>
          </div>
        </div>
        
        {/* 单选功能 */}
        <div className="grid gap-2">
          <Label>性别</Label>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="radio" 
                name="gender" 
                value="male" 
                checked={gender === "male"}
                onChange={(e) => setGender(e.target.value)}
              />
              <span>男</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input 
                type="radio" 
                name="gender" 
                value="female"
                checked={gender === "female"}
                onChange={(e) => setGender(e.target.value)}
              />
              <span>女</span>
            </label>
          </div>
        </div>

        {/* 日期选择功能 - 点击整个输入框都可选择 */}
        <div className="grid gap-2" ref={datePickerRef}>
          <Label htmlFor="birthday">出生日期</Label>
          <div className="relative">
            <Input 
              id="birthday" 
              type="text" 
              value={birthday}
              placeholder="选择日期"
              onClick={() => setShowDatePicker(!showDatePicker)}
              readOnly
              className="cursor-pointer"
            />
            {showDatePicker && (
              <div className="absolute top-full left-0 z-50 mt-1 w-[280px] rounded-lg border bg-white p-3 shadow-lg">
                <div className="mb-3 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={prevMonth}
                    className="rounded px-2 py-1 hover:bg-gray-100"
                  >
                    ‹
                  </button>
                  <span className="font-medium">
                    {currentYear}年 {monthNames[currentMonth]}
                  </span>
                  <button
                    type="button"
                    onClick={nextMonth}
                    className="rounded px-2 py-1 hover:bg-gray-100"
                  >
                    ›
                  </button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-sm">
                  {weekDays.map((day) => (
                    <div key={day} className="py-1 text-gray-400">
                      {day}
                    </div>
                  ))}
                  {emptyDays.map((_, index) => (
                    <div key={`empty-${index}`} />
                  ))}
                  {days.map((day) => (
                    <button
                      key={day}
                      type="button"
                      onClick={() => handleDateClick(day)}
                      className="rounded py-1 hover:bg-blue-100"
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 多行文本框功能 */}
        <div className="grid gap-2">
          <Label htmlFor="description">个人简介</Label>
          <textarea
            id="description"
            name="description"
            rows={4}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="请输入个人简介..."
          />
        </div>

        <Button type="submit" className="w-full">Sign In</Button>
      </div>
    </form>
  );
}
