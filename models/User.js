const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  uid:           { type: String, required: true, unique: true },  // Firebase UID
  email:         { type: String },
  displayName:   { type: String },
  role:          { type: String, enum: ['user','pro','elite','admin'], default: 'user' },
  plan:          { type: String, enum: ['free','pro','elite'], default: 'free' },
  suspended:     { type: Boolean, default: false },
  suspendReason: { type: String, default: '' },
  maintenance:   { type: Boolean, default: false },
  maintenanceMsg:{ type: String, default: '' },
  paperBalance:  { type: Number, default: 1000 },
  createdAt:     { type: Date, default: Date.now },
  lastLogin:     { type: Date }
});

module.exports = mongoose.model('User', UserSchema);
