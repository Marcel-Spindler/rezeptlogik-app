import type { MealCatalogEntry } from "../../core/types";
import { field, metric, titleOf, subtitleOf, tagsOf } from "./catalog-utils";

export async function exportCatalogXlsx(meals: MealCatalogEntry[], filename: string) {
  const { Workbook } = await import("exceljs");
  const wb = new Workbook();
  const ws = wb.addWorksheet("Meal Katalog");

  ws.columns = [
    { header: "Meal ID", key: "mealId", width: 14 },
    { header: "Name", key: "name", width: 30 },
    { header: "Sub Name", key: "subName", width: 30 },
    { header: "Cuisine", key: "cuisine", width: 16 },
    { header: "Protein Type", key: "proteinType", width: 18 },
    { header: "Meal Type", key: "mealType", width: 16 },
    { header: "Format", key: "format", width: 12 },
    { header: "Gewicht (g)", key: "weight", width: 12 },
    { header: "Kalorien", key: "calories", width: 10 },
    { header: "Protein (g)", key: "protein", width: 12 },
    { header: "Kohlenhydrate (g)", key: "carbs", width: 16 },
    { header: "Fett (g)", key: "fat", width: 10 },
    { header: "Tags", key: "tags", width: 30 },
    { header: "Status", key: "status", width: 14 },
  ];

  for (const meal of meals) {
    ws.addRow({
      mealId: meal.mealId,
      name: titleOf(meal),
      subName: subtitleOf(meal),
      cuisine: field(meal, "Meal DB_Culinary", "CUISINE"),
      proteinType: field(meal, "Meal DB_Culinary", "PROTEIN TYPE"),
      mealType: field(meal, "Meal DB_Culinary", "MEAL TYPE"),
      format: field(meal, "Meal DB_Culinary", "FORMAT"),
      weight: parseFloat(metric(meal, "MEAL WEIGHT (g)")) || "",
      calories: parseFloat(metric(meal, "CALORIES")) || "",
      protein: parseFloat(metric(meal, "PROTEIN (g)")) || "",
      carbs: parseFloat(metric(meal, "CARBS (g)")) || "",
      fat: parseFloat(metric(meal, "FAT (g)")) || "",
      tags: tagsOf(meal).join(", "),
      status: field(meal, "Meal DB_Culinary", "STATUS"),
    });
  }

  // Style header row
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
