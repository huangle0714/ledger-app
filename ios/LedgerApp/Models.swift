import Foundation
import SwiftData
import SwiftUI

@Model
final class CardAccount {
    var bankName: String
    var shortName: String
    var lastFour: String
    var creditLimit: Double
    var usedAmount: Double
    var dueDay: Int
    var status: String
    var colorHex: String
    var isUrgent: Bool

    init(bankName: String, shortName: String, lastFour: String, creditLimit: Double, usedAmount: Double, dueDay: Int, status: String, colorHex: String, isUrgent: Bool) {
        self.bankName = bankName
        self.shortName = shortName
        self.lastFour = lastFour
        self.creditLimit = creditLimit
        self.usedAmount = usedAmount
        self.dueDay = dueDay
        self.status = status
        self.colorHex = colorHex
        self.isUrgent = isUrgent
    }

    var availableAmount: Double { max(0, creditLimit - usedAmount) }
    var usageRatio: Double { creditLimit > 0 ? min(1, usedAmount / creditLimit) : 0 }
    var dueText: String { "8月\(dueDay)日" }
}

enum SampleData {
    static let cards: [CardAccount] = [
        CardAccount(bankName: "招商银行", shortName: "招行", lastFour: "8019", creditLimit: 50000, usedAmount: 1463, dueDay: 1, status: "已还清", colorHex: "3977EE", isUrgent: false),
        CardAccount(bankName: "中国银行", shortName: "中行", lastFour: "6131", creditLimit: 80000, usedAmount: 11427, dueDay: 2, status: "待还款", colorHex: "DC626C", isUrgent: true),
        CardAccount(bankName: "交通银行", shortName: "交行", lastFour: "4905", creditLimit: 193242, usedAmount: 101379, dueDay: 3, status: "待还款", colorHex: "ED9A3D", isUrgent: true),
        CardAccount(bankName: "工商银行", shortName: "工行", lastFour: "2118", creditLimit: 64500, usedAmount: 16547, dueDay: 5, status: "已还清", colorHex: "DC626C", isUrgent: false),
        CardAccount(bankName: "平安银行", shortName: "平安", lastFour: "6787", creditLimit: 100000, usedAmount: 3049, dueDay: 6, status: "已还清", colorHex: "27A992", isUrgent: false),
        CardAccount(bankName: "浦发银行", shortName: "浦发", lastFour: "2306", creditLimit: 0, usedAmount: 0, dueDay: 7, status: "未使用", colorHex: "8B67D8", isUrgent: false),
        CardAccount(bankName: "建设银行", shortName: "建行", lastFour: "4666", creditLimit: 120000, usedAmount: 72409, dueDay: 8, status: "待还款", colorHex: "3977EE", isUrgent: true),
        CardAccount(bankName: "广发银行", shortName: "广发", lastFour: "4078", creditLimit: 200000, usedAmount: 59133.03, dueDay: 10, status: "已还清", colorHex: "ED9A3D", isUrgent: false),
        CardAccount(bankName: "上海银行", shortName: "上海", lastFour: "7142", creditLimit: 120000, usedAmount: 72370.70, dueDay: 11, status: "待还款", colorHex: "27A992", isUrgent: false),
        CardAccount(bankName: "农业银行", shortName: "农行", lastFour: "7280", creditLimit: 75000, usedAmount: 12749, dueDay: 13, status: "已还清", colorHex: "27A992", isUrgent: false),
        CardAccount(bankName: "民生银行", shortName: "民生", lastFour: "5815", creditLimit: 50000, usedAmount: 1383, dueDay: 14, status: "已还清", colorHex: "8B67D8", isUrgent: false),
        CardAccount(bankName: "兴业银行", shortName: "兴业", lastFour: "7752", creditLimit: 120000, usedAmount: 71787, dueDay: 16, status: "待还款", colorHex: "3977EE", isUrgent: false)
    ]
}

extension Color {
    init(hex: String) {
        let value = UInt64(hex, radix: 16) ?? 0
        self.init(.sRGB, red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255, opacity: 1)
    }
}

extension Double {
    var moneyText: String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencySymbol = "¥"
        formatter.maximumFractionDigits = truncatingRemainder(dividingBy: 1) == 0 ? 0 : 2
        formatter.minimumFractionDigits = 0
        return formatter.string(from: NSNumber(value: self)) ?? "¥0"
    }
}
